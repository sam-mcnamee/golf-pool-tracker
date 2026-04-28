#!/usr/bin/env python3

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
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
    # Supabase returns ISO; handle trailing Z.
    s2 = s.replace("Z", "+00:00")
    return datetime.fromisoformat(s2)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def main() -> int:
    supabase_url = must_env("SUPABASE_URL")
    service_key = must_env("SUPABASE_SERVICE_ROLE_KEY")
    sb: Client = create_client(supabase_url, service_key)

    # Only update non-complete tournaments.
    q = (
        sb.table("tournaments")
        .select("id,status,open_at,lock_at,first_tee_at")
        .neq("status", "Complete")
        .execute()
    )
    rows = q.data or []

    n = now_utc()
    updated = 0

    for t in rows:
        tid = t["id"]
        status = t["status"]
        open_at = parse_ts(t.get("open_at"))
        lock_at = parse_ts(t.get("lock_at"))
        first_tee_at = parse_ts(t.get("first_tee_at"))

        next_status: Optional[str] = None

        if status == "Upcoming" and open_at and n >= open_at:
            next_status = "Open"
        elif status == "Open":
            if (lock_at and n >= lock_at) or (first_tee_at and n >= first_tee_at):
                next_status = "Locked"
        elif status == "Locked":
            if first_tee_at and n >= first_tee_at:
                next_status = "Live"

        if next_status and next_status != status:
            patch: Dict[str, Any] = {"status": next_status}
            sb.table("tournaments").update(patch).eq("id", tid).execute()
            updated += 1

    print(f"Scheduler updated {updated} tournaments")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        raise

