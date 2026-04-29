"""Shared Supabase helpers for scrapers (current tournament selection)."""

from __future__ import annotations

from typing import Any, Dict

from supabase import Client


def pick_current_tournament(sb: Client) -> Dict[str, Any]:
    """Latest non-complete tournament by created_at (matches admin odds UI)."""
    q = (
        sb.table("tournaments")
        .select("id,name,espn_event_id,status")
        .neq("status", "Complete")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = q.data or []
    if not rows:
        raise RuntimeError("No active tournament found in Supabase")
    return rows[0]
