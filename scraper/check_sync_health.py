#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from supabase import Client, create_client

_FRAC_RE = re.compile(r"\.(\d+)")


def must_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


def parse_ts(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    # Python 3.10's datetime.fromisoformat requires fractional seconds to be 3 or 6 digits;
    # Supabase often returns 4 or 5. Normalize to 6.
    normalized = s.replace("Z", "+00:00")
    normalized = _FRAC_RE.sub(lambda m: "." + (m.group(1) + "000000")[:6], normalized)
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


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
    ap.add_argument(
        "--stale-minutes",
        type=int,
        default=25,
        help="Fail when a Live tournament's sync_health.last_success_at is older than this",
    )
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

    stale_live = False
    any_updates = False
    for t in tournaments:
        tid = str(t["id"])
        if t.get("status") == "Live":
            sh = (
                sb.table("sync_health")
                .select("last_success_at,last_run_at,last_error")
                .eq("tournament_id", tid)
                .limit(1)
                .execute()
            )
            health_rows = sh.data or []
            last_success = parse_ts(health_rows[0].get("last_success_at")) if health_rows else None
            age_min = (now_utc() - last_success).total_seconds() / 60 if last_success else None
            if last_success is not None and age_min is not None:
                print(
                    f"sync_health tournament={t.get('name')} id={tid} status=Live "
                    f"last_success_at={health_rows[0].get('last_success_at')} age_min={age_min:.1f}"
                )
            else:
                print(f"sync_health tournament={t.get('name')} id={tid} status=Live last_success_at=None")
            if last_success is None or age_min > args.stale_minutes:
                stale_live = True
                print(
                    f"ERROR: Live tournament {t.get('name')} has stale sync_health "
                    f"(last_success_at older than {args.stale_minutes}m).",
                    file=sys.stderr,
                )

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

    if stale_live:
        return 2

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
