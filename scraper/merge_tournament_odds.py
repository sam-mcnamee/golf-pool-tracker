#!/usr/bin/env python3
"""
Merge rows in tournament_odds_latest for one tournament: same player (normalized
name) may appear from golfodds vs dknetwork with different spellings. Keep the
row with lowest American odds (favorite); tie-break golfodds over dknetwork.
Sets source to 'merged' and refreshes fetched_at.
"""

from __future__ import annotations

import os
import re
import sys
import unicodedata
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from supabase import Client, create_client

from tournament_context import pick_current_tournament


def must_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


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


def _source_priority(source: str) -> int:
    return {"golfodds": 0, "dknetwork": 1, "merged": 2}.get(source or "", 9)


def pick_winner_row(a: Dict[str, Any], b: Dict[str, Any]) -> Dict[str, Any]:
    """Prefer lower American odds; tie-break by source then golfer_name."""
    oa, ob = int(a["odds_american"]), int(b["odds_american"])
    if oa != ob:
        return a if oa < ob else b
    pa, pb = _source_priority(str(a.get("source", ""))), _source_priority(str(b.get("source", "")))
    if pa != pb:
        return a if pa < pb else b
    return a if str(a.get("golfer_name", "")) <= str(b.get("golfer_name", "")) else b


def merge_rows_for_tournament(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    best_by_norm: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        key = normalize_name(str(r.get("golfer_name", "")))
        if not key:
            continue
        prev = best_by_norm.get(key)
        if prev is None:
            best_by_norm[key] = dict(r)
        else:
            best_by_norm[key] = pick_winner_row(prev, dict(r))

    now = datetime.now(timezone.utc).isoformat()
    merged: List[Dict[str, Any]] = []
    for key, w in best_by_norm.items():
        # Prefer non-null golfer_id from any row that tied on normalized name
        gid: Optional[str] = w.get("golfer_id")
        if not gid:
            for r in rows:
                if normalize_name(str(r.get("golfer_name", ""))) != key:
                    continue
                if r.get("golfer_id"):
                    gid = str(r["golfer_id"])
                    break

        merged.append(
            {
                "tournament_id": w["tournament_id"],
                "golfer_id": gid,
                "golfer_name": str(w["golfer_name"]),
                "odds_american": int(w["odds_american"]),
                "source": "merged",
                "source_url": w.get("source_url"),
                "fetched_at": now,
            }
        )
    merged.sort(key=lambda x: (x["odds_american"], x["golfer_name"]))
    return merged


def merge_tournament_odds(sb: Client, tournament_id: str) -> Tuple[int, int]:
    """
    Replace all odds rows for tournament with merged set.
    Returns (total_rows, matched_golfer_count).
    """
    q = sb.table("tournament_odds_latest").select("*").eq("tournament_id", tournament_id).execute()
    rows = q.data or []
    if not rows:
        return (0, 0)

    merged = merge_rows_for_tournament(rows)
    sb.table("tournament_odds_latest").delete().eq("tournament_id", tournament_id).execute()
    if merged:
        sb.table("tournament_odds_latest").insert(merged).execute()

    matched = sum(1 for r in merged if r.get("golfer_id"))
    return (len(merged), matched)


def main() -> int:
    supabase_url = must_env("SUPABASE_URL")
    service_key = must_env("SUPABASE_SERVICE_ROLE_KEY")
    sb: Client = create_client(supabase_url, service_key)
    t = pick_current_tournament(sb)
    tid = str(t["id"])
    n, matched = merge_tournament_odds(sb, tid)
    print(f"Merged tournament_odds_latest for {tid}: {n} rows, {matched} matched to golfers")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        raise
