#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from supabase import Client, create_client


def must_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


def parse_ts(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def list_active_tournaments(sb: Client) -> list[Dict[str, Any]]:
    q = sb.table("tournaments").select("id,name,status,cut_complete,created_at").neq("status", "Complete").execute()
    rows = q.data or []
    if not rows:
        raise RuntimeError("No active (non-Complete) tournament found")
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description="Quick health check for ESPN sync -> Supabase golfers table.")
    ap.add_argument("--tournament-id", help="Supabase tournaments.id (uuid). Defaults to latest non-Complete tournament.")
    ap.add_argument("--minutes", type=int, default=30, help="How far back to look for golfer updates")
    args = ap.parse_args()

    supabase_url = must_env("SUPABASE_URL")
    service_key = must_env("SUPABASE_SERVICE_ROLE_KEY")
    sb: Client = create_client(supabase_url, service_key)

    since = now_utc() - timedelta(minutes=args.minutes)

    if args.tournament_id:
        tournaments = (
            sb.table("tournaments")
            .select("id,name,status,cut_complete,created_at")
            .eq("id", args.tournament_id)
            .limit(1)
            .execute()
            .data
            or []
        )
        if not tournaments:
            print(f"ERROR: No tournament with id={args.tournament_id}", file=sys.stderr)
            return 2
    else:
        tournaments = list_active_tournaments(sb)

    any_updates = False
    for t in tournaments:
        tid = str(t["id"])
        q = (
            sb.table("golfers")
            .select("id,name,updated_at,total_score,today_score,current_round,thru,status,is_cut")
            .eq("tournament_id", tid)
            .gte("updated_at", since.isoformat())
            .order("updated_at", desc=True)
            .limit(25)
            .execute()
        )
        rows = q.data or []
        print(
            f"tournament={t.get('name')} id={tid} status={t.get('status')} cut_complete={t.get('cut_complete')} "
            f"updated_rows={len(rows)}"
        )
        if rows:
            any_updates = True
            print(f"since={since.isoformat()} (showing up to 25)")
            for r in rows:
                upd = parse_ts(r.get("updated_at"))
                age = f"{(now_utc() - upd).total_seconds():.0f}s" if upd else "?"
                print(
                    f"- {r.get('updated_at')} ({age} ago) {r.get('name')} "
                    f"total={r.get('total_score')} today={r.get('today_score')} "
                    f"round={r.get('current_round')} thru={r.get('thru')} status={r.get('status')} is_cut={r.get('is_cut')}"
                )

    if not any_updates:
        print(
            "ERROR: No golfers updated recently on any active tournament. Sync may not be running or is failing.",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        raise

