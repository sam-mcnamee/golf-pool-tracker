#!/usr/bin/env python3
"""
Run ESPN field sync, then golfodds + dknetwork odds, then merge tournament_odds_latest
(lowest American odds per normalized player name). Exits non-zero if too few matched
golfers after merge (default min 20).
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from supabase import Client, create_client

from merge_tournament_odds import merge_tournament_odds
from tournament_context import pick_current_tournament


def must_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


def run_script(scraper_dir: Path, script: str, *, check: bool) -> int:
    cmd = [sys.executable, str(scraper_dir / script)]
    p = subprocess.run(cmd, cwd=str(scraper_dir), env=os.environ.copy())
    if check and p.returncode != 0:
        return p.returncode
    return p.returncode


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-matched", type=int, default=20, help="Minimum golfers with odds matched to field after merge")
    ap.add_argument("--skip-merge", action="store_true", help="Skip merge step (not recommended)")
    args = ap.parse_args()

    scraper_dir = Path(__file__).resolve().parent

    # Odds sources are independent of the ESPN field: when ESPN hasn't published
    # the competitor list yet (common pre-tournament Tuesday), we still want to
    # pull odds from golfodds + DK Network so admins can freeze tiers as soon as
    # ESPN catches up. Failures are reported but the pipeline continues; the
    # final --min-matched check (after merge) is the real gate.
    for script in (
        "espn_leaderboard_sync.py",
        "golfodds_weekly_sync.py",
        "dknetwork_odds_sync.py",
    ):
        rc = run_script(scraper_dir, script, check=False)
        if rc != 0:
            print(f"WARNING: {script} exited {rc}; continuing pipeline", file=sys.stderr)

    if args.skip_merge:
        print("Skipping merge (--skip-merge)")
        return 0

    supabase_url = must_env("SUPABASE_URL")
    service_key = must_env("SUPABASE_SERVICE_ROLE_KEY")
    sb: Client = create_client(supabase_url, service_key)
    t = pick_current_tournament(sb)
    tid = str(t["id"])
    n, matched = merge_tournament_odds(sb, tid)
    print(f"Pipeline merge: {n} odds rows, {matched} matched to ESPN field")

    if matched < args.min_matched:
        # When ESPN hasn't published the competitor field for this tournament
        # yet (common pre-tournament Tuesday), the merge will report 0 matched
        # even though odds were imported successfully. Treat that as a soft
        # warning so the workflow doesn't fire a red alert every Tuesday morning
        # while we wait for ESPN to catch up. The auto-relink path inside
        # espn_leaderboard_sync.py will reconcile golfer_id on a later run.
        try:
            gq = sb.table("golfers").select("id", count="exact").eq("tournament_id", tid).execute()
            field_count = int(getattr(gq, "count", None) or len(gq.data or []))
        except Exception:  # noqa: BLE001
            field_count = -1

        if field_count == 0 and n > 0:
            print(
                f"WARNING: Imported {n} odds rows but ESPN field is not yet populated "
                f"(0 golfers). Auto-relink will match them on a later run.",
                file=sys.stderr,
            )
            return 0

        print(
            f"ERROR: Only {matched} matched golfers (need >= {args.min_matched}). "
            "Check ESPN sync, name matching, and odds sources.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        raise SystemExit(1)
