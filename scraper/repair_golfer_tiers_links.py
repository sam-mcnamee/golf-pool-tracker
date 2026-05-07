#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import re
import sys
import unicodedata
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


def parse_ts(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def normalize_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    for old, new in (
        ("ø", "o"),
        ("Ø", "o"),
        ("æ", "ae"),
        ("Æ", "ae"),
        ("å", "a"),
        ("Å", "a"),
        ("ö", "o"),
        ("Ö", "o"),
        ("ü", "u"),
        ("Ü", "u"),
    ):
        s = s.replace(old, new)
    return re.sub(r"[^a-z]+", " ", s.lower()).strip()


def pick_active_tournament(sb: Client) -> Dict[str, Any]:
    q = (
        sb.table("tournaments")
        .select("id,name,status,created_at")
        .neq("status", "Complete")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = q.data or []
    if not rows:
        raise RuntimeError("No active (non-Complete) tournament found")
    return rows[0]


def golfer_authority_key(g: Dict[str, Any]) -> Tuple[int, int, float]:
    """
    Higher is better.
    Prefer rows that are actively receiving ESPN updates / have scoring fields populated.
    """
    has_score = 1 if any(g.get(k) is not None for k in ("total_score", "today_score", "current_round")) else 0
    has_thru = 1 if isinstance(g.get("thru"), str) and g.get("thru").strip() else 0
    upd = parse_ts(g.get("updated_at"))
    upd_ts = upd.timestamp() if upd else 0.0
    return (has_score, has_thru, upd_ts)


def pick_authoritative_golfer(golfers: List[Dict[str, Any]]) -> Dict[str, Any]:
    # max() by our authority key
    return max(golfers, key=golfer_authority_key)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Repair golfer_tiers links to point at the authoritative golfers rows (ESPN-updated)."
    )
    ap.add_argument("--tournament-id", help="Supabase tournaments.id (uuid). Defaults to latest non-Complete tournament.")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    supabase_url = must_env("SUPABASE_URL")
    service_key = must_env("SUPABASE_SERVICE_ROLE_KEY")
    sb: Client = create_client(supabase_url, service_key)

    if args.tournament_id:
        tq = (
            sb.table("tournaments")
            .select("id,name,status,created_at")
            .eq("id", args.tournament_id)
            .limit(1)
            .execute()
        )
        trows = tq.data or []
        if not trows:
            raise RuntimeError("Tournament not found")
        t = trows[0]
    else:
        t = pick_active_tournament(sb)

    tid = str(t["id"])

    gq = (
        sb.table("golfers")
        .select("id,name,espn_athlete_id,total_score,today_score,current_round,thru,status,is_cut,updated_at")
        .eq("tournament_id", tid)
        .execute()
    )
    golfers = list(gq.data or [])
    if not golfers:
        raise RuntimeError("No golfers found for tournament")

    # Map normalized name -> authoritative golfer id
    golfers_by_norm: Dict[str, List[Dict[str, Any]]] = {}
    for g in golfers:
        key = normalize_name(str(g.get("name", "")))
        if not key:
            continue
        golfers_by_norm.setdefault(key, []).append(g)

    authoritative_by_norm: Dict[str, str] = {}
    for key, group in golfers_by_norm.items():
        authoritative = pick_authoritative_golfer(group)
        authoritative_by_norm[key] = str(authoritative["id"])

    # Find golfer_tiers that point at a non-authoritative golfer for the same name.
    # We join via fetching tiers + golfer name.
    tq2 = (
        sb.table("golfer_tiers")
        .select("id,golfer_id,golfers:golfer_id(id,name)")
        .eq("tournament_id", tid)
        .execute()
    )
    tiers = list(tq2.data or [])

    tier_patches: List[Dict[str, Any]] = []
    for tr in tiers:
        g0 = tr.get("golfers")
        if not isinstance(g0, dict):
            continue
        name = str(g0.get("name", ""))
        norm = normalize_name(name)
        if not norm:
            continue
        want = authoritative_by_norm.get(norm)
        have = tr.get("golfer_id")
        if want and have and str(have) != want:
            tier_patches.append({"id": tr["id"], "golfer_id": want})

    # Also update tournament_odds_latest links (helps freeze/odds display; not required for leaderboard but keeps DB consistent).
    oq = (
        sb.table("tournament_odds_latest")
        .select("id,golfer_id,golfer_name")
        .eq("tournament_id", tid)
        .execute()
    )
    odds = list(oq.data or [])
    odds_patches: List[Dict[str, Any]] = []
    for o in odds:
        name = str(o.get("golfer_name", ""))
        norm = normalize_name(name)
        if not norm:
            continue
        want = authoritative_by_norm.get(norm)
        have = o.get("golfer_id")
        if want and have and str(have) != want:
            odds_patches.append({"id": o["id"], "golfer_id": want})

    print(
        f"[{now_utc().isoformat()}] tournament={t.get('name')} id={tid} "
        f"tier_links_to_fix={len(tier_patches)} odds_links_to_fix={len(odds_patches)} dry_run={args.dry_run}"
    )

    if args.dry_run:
        if tier_patches:
            print("Would update golfer_tiers:")
            for p in tier_patches[:50]:
                print(f"- golfer_tiers.id={p['id']} -> golfer_id={p['golfer_id']}")
            if len(tier_patches) > 50:
                print(f"... and {len(tier_patches) - 50} more")
        if odds_patches:
            print("Would update tournament_odds_latest:")
            for p in odds_patches[:50]:
                print(f"- tournament_odds_latest.id={p['id']} -> golfer_id={p['golfer_id']}")
            if len(odds_patches) > 50:
                print(f"... and {len(odds_patches) - 50} more")
        return 0

    if tier_patches:
        sb.table("golfer_tiers").upsert(tier_patches, on_conflict="id").execute()
        print(f"Updated {len(tier_patches)} golfer_tiers links")

    if odds_patches:
        sb.table("tournament_odds_latest").upsert(odds_patches, on_conflict="id").execute()
        print(f"Updated {len(odds_patches)} tournament_odds_latest links")

    if not tier_patches and not odds_patches:
        print("No link repairs needed")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        raise

