#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

import requests
from supabase import Client, create_client


ESPN_ENDPOINT = "https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard"
ET = ZoneInfo("America/New_York")


def must_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


def espn_get_json(event_id: str, *, timeout_s: int = 20, retries: int = 3) -> Dict[str, Any]:
    url = f"{ESPN_ENDPOINT}?event={event_id}"
    last_err: Optional[Exception] = None
    for i in range(retries):
        try:
            r = requests.get(url, timeout=timeout_s, headers={"accept": "application/json"})
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"Failed to fetch ESPN JSON after {retries} tries: {last_err}")


def espn_get_events(*, league: str = "pga", timeout_s: int = 20, retries: int = 3) -> Dict[str, Any]:
    url = f"{ESPN_ENDPOINT}?league={league}"
    last_err: Optional[Exception] = None
    for i in range(retries):
        try:
            r = requests.get(url, timeout=timeout_s, headers={"accept": "application/json"})
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"Failed to fetch ESPN events JSON after {retries} tries: {last_err}")


def pick_primary_event_id(events_payload: Dict[str, Any]) -> Tuple[str, str, Optional[str]]:
    events = events_payload.get("events")
    if not isinstance(events, list):
        raise RuntimeError("ESPN events payload missing 'events' list")

    primary = None
    for e in events:
        if isinstance(e, dict) and e.get("primary") is True and e.get("id") and e.get("name"):
            primary = e
            break
    if primary is None:
        # Fallback: first event that looks valid
        for e in events:
            if isinstance(e, dict) and e.get("id") and e.get("name"):
                primary = e
                break

    if primary is None:
        raise RuntimeError("Could not find a primary event in ESPN events list")

    event_id = str(primary["id"])
    name = str(primary["name"])
    start_date = primary.get("date")
    return (event_id, name, start_date if isinstance(start_date, str) else None)


def compute_open_lock_from_start(start_iso: Optional[str]) -> Tuple[datetime, datetime]:
    """
    Given ESPN start date (ISO-ish, often '2026-04-23T04:00Z'), compute:
    - open_at: Monday 8:00 AM ET of tournament week
    - lock_at: Thursday 7:00 AM ET of tournament week
    """
    now_et = datetime.now(ET)
    if not start_iso:
        # Safe defaults: open now, lock in 3 days
        return (now_et, now_et + timedelta(days=3))

    s = start_iso.replace("Z", "+00:00")
    start_utc = datetime.fromisoformat(s)
    start_et = start_utc.astimezone(ET)

    # Find Monday of that week (Mon=0)
    monday = (start_et - timedelta(days=start_et.weekday())).replace(hour=8, minute=0, second=0, microsecond=0)
    thursday = (monday + timedelta(days=3)).replace(hour=7, minute=0, second=0, microsecond=0)
    return (monday, thursday)


def ensure_current_tournament(sb: Client) -> Tuple[str, str]:
    """
    Ensure a tournament exists for ESPN's current/primary PGA event and return (tournament_id, espn_event_id).
    """
    events_payload = espn_get_events(league="pga")
    espn_event_id, name, start_date = pick_primary_event_id(events_payload)
    open_at_et, lock_at_et = compute_open_lock_from_start(start_date)

    sb.table("tournaments").upsert(
        {
            "name": name,
            "espn_event_id": espn_event_id,
            "open_at": open_at_et.astimezone(ZoneInfo("UTC")).isoformat(),
            "lock_at": lock_at_et.astimezone(ZoneInfo("UTC")).isoformat(),
        },
        on_conflict="espn_event_id",
    ).execute()

    # supabase-py doesn't consistently support select().single() chaining on upsert across versions.
    sel = sb.table("tournaments").select("id,espn_event_id").eq("espn_event_id", espn_event_id).limit(1).execute()
    rows = sel.data or []
    if not rows:
        raise RuntimeError("Failed to read back current tournament after upsert")
    return (rows[0]["id"], rows[0]["espn_event_id"])

def deep_find_first_list(obj: Any, key: str) -> Optional[List[Any]]:
    if isinstance(obj, dict):
        if key in obj and isinstance(obj[key], list):
            return obj[key]
        for v in obj.values():
            found = deep_find_first_list(v, key)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = deep_find_first_list(v, key)
            if found is not None:
                return found
    return None


def deep_find_first_dict(obj: Any, key: str) -> Optional[Dict[str, Any]]:
    if isinstance(obj, dict):
        if key in obj and isinstance(obj[key], dict):
            return obj[key]
        for v in obj.values():
            found = deep_find_first_dict(v, key)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = deep_find_first_dict(v, key)
            if found is not None:
                return found
    return None


def parse_total_score(score_str: Optional[str]) -> Tuple[Optional[int], Optional[str], Optional[bool]]:
    """
    Returns (total_score_int, status_text, is_cut)

    Robustness rules:
    - "E" => 0
    - "+2" => 2
    - "-13" => -13
    - "CUT" => status="CUT", is_cut=False, total_score=None
    - "WD"/"DQ" => status="WD"/"DQ", is_cut=False, total_score=None
    - "--" / None => total_score=None
    """
    if score_str is None:
        return (None, None, None)

    s = score_str.strip().upper()
    if s in ("", "--"):
        return (None, None, None)
    if s in ("-", "MC"):
        # Some feeds use "-" or "MC" markers; treat as missed cut/disqualified from scoring.
        return (None, "CUT", False)
    if s == "E":
        return (0, None, None)
    if s in ("CUT", "WD", "DQ"):
        return (None, s, False)
    try:
        return (int(s.replace("+", "")), None, None)
    except Exception:  # noqa: BLE001
        # Unknown marker; keep as status.
        return (None, s, None)


@dataclass(frozen=True)
class GolferUpdate:
    espn_athlete_id: str
    name: str
    total_score: Optional[int]
    thru: Optional[str]
    status: Optional[str]
    is_cut: Optional[bool]


def extract_competitors(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    competitors = deep_find_first_list(payload, "competitors")
    if competitors and all(isinstance(x, dict) for x in competitors):
        return competitors  # type: ignore[return-value]

    # Some ESPN payloads use "entries" for leaderboard rows.
    entries = deep_find_first_list(payload, "entries")
    if entries and all(isinstance(x, dict) for x in entries):
        return entries  # type: ignore[return-value]

    raise RuntimeError("Could not find competitors/entries list in ESPN payload")


def competitor_to_update(row: Dict[str, Any]) -> Optional[GolferUpdate]:
    athlete = row.get("athlete") or deep_find_first_dict(row, "athlete")
    if not isinstance(athlete, dict):
        return None

    athlete_id = athlete.get("id")
    name = athlete.get("displayName") or athlete.get("name")
    if not athlete_id or not name:
        return None

    score_str = row.get("score") or row.get("displayScore") or row.get("totalScore")
    total_score, score_status, score_is_cut = parse_total_score(score_str if isinstance(score_str, str) else None)

    status_text: Optional[str] = None
    is_cut: Optional[bool] = None

    status_obj = row.get("status")
    if isinstance(status_obj, dict):
        t = status_obj.get("type")
        if isinstance(t, dict):
            status_text = t.get("name") or t.get("description") or status_obj.get("detail")
        else:
            status_text = status_obj.get("detail") or status_obj.get("description")

    if score_status:
        status_text = score_status
    if score_is_cut is not None:
        is_cut = score_is_cut

    # Weekend rounds implies made cut.
    linescores = row.get("linescores")
    if is_cut is None and isinstance(linescores, list) and len(linescores) >= 3:
        is_cut = True

    # "CUT" marker sometimes appears in status detail.
    if is_cut is None and status_text and "CUT" in status_text.upper():
        is_cut = False

    thru = row.get("thru") or row.get("displayThru") or row.get("through")
    if not isinstance(thru, str):
        thru = None

    return GolferUpdate(
        espn_athlete_id=str(athlete_id),
        name=str(name),
        total_score=total_score,
        thru=thru,
        status=status_text,
        is_cut=is_cut,
    )


def detect_event_status(payload: Dict[str, Any]) -> Tuple[Optional[str], bool]:
    """
    Returns (tournament_status, is_final)
    tournament_status is one of: Upcoming/Open/Locked/Live/Complete (we only set Live/Complete here).
    """
    status = deep_find_first_dict(payload, "status")
    if not status:
        return (None, False)

    t = status.get("type") if isinstance(status, dict) else None
    if isinstance(t, dict):
        name = (t.get("name") or t.get("description") or "").upper()
        state = (t.get("state") or "").upper()
        if "FINAL" in name or state == "POST":
            return ("Complete", True)
        if state in ("IN", "INPROGRESS", "LIVE"):
            return ("Live", False)
    detail = (status.get("detail") or status.get("description") or "").upper() if isinstance(status, dict) else ""
    if "FINAL" in detail:
        return ("Complete", True)
    return (None, False)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tournament-id", help="Supabase tournaments.id (uuid)")
    ap.add_argument("--espn-event-id", help="ESPN event id (tournamentId)")
    ap.add_argument("--mode", choices=["current"], default="current")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    supabase_url = must_env("SUPABASE_URL")
    service_key = must_env("SUPABASE_SERVICE_ROLE_KEY")
    sb: Client = create_client(supabase_url, service_key)

    tournament_id: Optional[str] = args.tournament_id
    espn_event_id: Optional[str] = args.espn_event_id

    if not tournament_id or not espn_event_id:
        if args.mode != "current":
            raise RuntimeError("Provide --tournament-id and --espn-event-id, or use --mode current")

        q = (
            sb.table("tournaments")
            .select("id,espn_event_id,status")
            .neq("status", "Complete")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = q.data or []
        if rows:
            tournament_id = rows[0]["id"]
            espn_event_id = rows[0]["espn_event_id"]

        # If no active tournament or espn_event_id isn't numeric, auto-select from ESPN.
        if not tournament_id or not espn_event_id or not str(espn_event_id).isdigit():
            tournament_id, espn_event_id = ensure_current_tournament(sb)

    payload = espn_get_json(str(espn_event_id))
    competitors = extract_competitors(payload)

    updates: List[GolferUpdate] = []
    for row in competitors:
        if not isinstance(row, dict):
            continue
        u = competitor_to_update(row)
        if u is not None:
            updates.append(u)

    if not updates:
        raise RuntimeError("No golfers parsed from ESPN payload")

    tournament_status, _is_final = detect_event_status(payload)

    # Heuristic: if there are any explicit missed-cut markers, assume cut has happened.
    cut_complete = any((u.is_cut is False and (u.status or "") == "CUT") for u in updates)

    if args.dry_run:
        print(json.dumps({"tournament_id": tournament_id, "espn_event_id": espn_event_id, "count": len(updates)}))
        return 0

    # Upsert golfers into tournament.
    golfer_rows = []
    for u in updates:
        row: Dict[str, Any] = {
            "tournament_id": tournament_id,
            "espn_athlete_id": u.espn_athlete_id,
            "name": u.name,
            "total_score": u.total_score,
            "thru": u.thru,
            "status": u.status,
            "is_cut": u.is_cut,
        }
        golfer_rows.append(row)

    sb.table("golfers").upsert(golfer_rows, on_conflict="tournament_id,espn_athlete_id").execute()

    # Update tournament flags.
    t_patch: Dict[str, Any] = {}
    if tournament_status in ("Live", "Complete"):
        t_patch["status"] = tournament_status
    if cut_complete:
        t_patch["cut_complete"] = True
    if t_patch:
        sb.table("tournaments").update(t_patch).eq("id", tournament_id).execute()

    print(f"Synced {len(updates)} golfers for tournament_id={tournament_id}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        raise

