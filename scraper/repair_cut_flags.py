#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from supabase import Client, create_client


def must_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def pick_active_tournament(sb: Client) -> Dict[str, Any]:
    q = (
        sb.table("tournaments")
        .select("id,name,status,cut_complete,created_at")
        .neq("status", "Complete")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = q.data or []
    if not rows:
        raise RuntimeError("No active (non-Complete) tournament found")
    return rows[0]


def fetch_golfers(sb: Client, tournament_id: str) -> List[Dict[str, Any]]:
    q = (
        sb.table("golfers")
        .select("id,name,r1_score,r2_score,r3_score,r4_score,total_score,today_score,current_round,thru,status,is_cut,updated_at")
        .eq("tournament_id", tournament_id)
        .execute()
    )
    return list(q.data or [])


def is_likely_placeholder_cut(g: Dict[str, Any]) -> bool:
    """
    Identify golfer rows that look like they were incorrectly marked CUT/MC before any data arrived.

    We only touch golfers that:
    - have explicit CUT status + is_cut false
    - and have no round scores, no totals, no current_round, and no thru
    """
    status = (g.get("status") or "").strip().upper()
    is_cut = g.get("is_cut")
    if not (status == "CUT" and is_cut is False):
        return False

    score_fields = ("r1_score", "r2_score", "r3_score", "r4_score", "total_score", "today_score", "current_round")
    if any(g.get(k) is not None for k in score_fields):
        return False

    thru = g.get("thru")
    if isinstance(thru, str) and thru.strip():
        return False

    return True


def compute_should_unset_cut_complete(golfers: List[Dict[str, Any]]) -> bool:
    any_weekend_started = any(g.get("r3_score") is not None or g.get("r4_score") is not None or (g.get("current_round") or 0) >= 3 for g in golfers)
    any_explicit_cut = any(((g.get("status") or "").strip().upper() == "CUT") and (g.get("is_cut") is False) for g in golfers)
    # If there's no weekend evidence, we should not have cut_complete true.
    return (not any_weekend_started) and any_explicit_cut


def main() -> int:
    ap = argparse.ArgumentParser(description="Repair early/placeholder CUT flags and cut_complete.")
    ap.add_argument("--tournament-id", help="Supabase tournaments.id (uuid). Defaults to latest non-Complete tournament.")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    supabase_url = must_env("SUPABASE_URL")
    service_key = must_env("SUPABASE_SERVICE_ROLE_KEY")
    sb: Client = create_client(supabase_url, service_key)

    t: Dict[str, Any]
    if args.tournament_id:
        q = (
            sb.table("tournaments")
            .select("id,name,status,cut_complete,created_at")
            .eq("id", args.tournament_id)
            .limit(1)
            .execute()
        )
        rows = q.data or []
        if not rows:
            raise RuntimeError("Tournament not found")
        t = rows[0]
    else:
        t = pick_active_tournament(sb)

    tid = str(t["id"])
    golfers = fetch_golfers(sb, tid)

    placeholders = [g for g in golfers if is_likely_placeholder_cut(g)]
    unset_cut_complete = bool(t.get("cut_complete")) and compute_should_unset_cut_complete(golfers)

    print(
        f"[{now_utc().isoformat()}] tournament={t.get('name')} id={tid} "
        f"cut_complete={t.get('cut_complete')} placeholders={len(placeholders)} dry_run={args.dry_run}"
    )

    if args.dry_run:
        if placeholders:
            print("Would clear CUT flags for:")
            for g in placeholders[:50]:
                print(f"- {g.get('name')} ({g.get('id')})")
            if len(placeholders) > 50:
                print(f"... and {len(placeholders) - 50} more")
        if unset_cut_complete:
            print("Would set tournaments.cut_complete=false")
        return 0

    # Patch golfers in batches.
    if placeholders:
        patch_rows: List[Dict[str, Any]] = [{"id": g["id"], "status": None, "is_cut": None} for g in placeholders]
        sb.table("golfers").upsert(patch_rows, on_conflict="id").execute()
        print(f"Cleared CUT flags for {len(placeholders)} golfers")

    if unset_cut_complete:
        sb.table("tournaments").update({"cut_complete": False}).eq("id", tid).execute()
        print("Unset tournaments.cut_complete")

    if not placeholders and not unset_cut_complete:
        print("No repairs needed")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        raise

