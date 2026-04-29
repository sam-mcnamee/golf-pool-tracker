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
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-matched", type=int, default=20, help="Minimum golfers with odds matched to field after merge")
    ap.add_argument("--skip-merge", action="store_true", help="Skip merge step (not recommended)")
    args = ap.parse_args()

    scraper_dir = Path(__file__).resolve().parent

    for script, check in (
        ("espn_leaderboard_sync.py", True),
        ("golfodds_weekly_sync.py", False),
        ("dknetwork_odds_sync.py", False),
    ):
        rc = run_script(scraper_dir, script, check=check)
        if rc != 0:
            print(f"Pipeline stopped: {script} exited {rc}", file=sys.stderr)
            return rc

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
