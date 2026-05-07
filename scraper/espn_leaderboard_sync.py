#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple
from zoneinfo import ZoneInfo

import requests
try:
    from supabase import Client, create_client  # type: ignore
except ModuleNotFoundError:  # pragma: no cover
    # Allow this script to run even when the Python `supabase` dependency isn't installed.
    # We'll fall back to direct Supabase REST calls in that case.
    Client = Any  # type: ignore
    create_client = None  # type: ignore


ESPN_ENDPOINT = "https://site.api.espn.com/apis/site/v2/sports/golf/leaderboard"
ESPN_CORE_BASE = "https://sports.core.api.espn.com/v2/sports/golf/leagues/pga"
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


def espn_get_json_url(url: str, *, timeout_s: int = 20, retries: int = 3) -> Dict[str, Any]:
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


def _try_parse_iso_datetime(s: str) -> Optional[datetime]:
    t = s.strip()
    if not t:
        return None
    # ESPN commonly uses Z.
    t = t.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(t)
    except Exception:  # noqa: BLE001
        return None


def _iter_candidate_time_strings(obj: Any) -> Iterable[str]:
    """
    Heuristic scan for tee/start time fields in ESPN core payloads.
    We keep this permissive because ESPN structures vary by event and pre/post tee-times.
    """
    wanted_keys = {
        "teeTime",
        "tee_time",
        "teeTimeUTC",
        "startDate",
        "startTime",
        "teeOffTime",
        "teetime",
        "teetimeutc",
        "startdate",
        "starttime",
    }
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(k, str) and k in wanted_keys and isinstance(v, str):
                yield v
            else:
                yield from _iter_candidate_time_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _iter_candidate_time_strings(v)


def compute_first_tee_time_utc_from_core(event_id: str) -> Optional[datetime]:
    """
    Attempt to compute the earliest Round 1 tee time using ESPN's Core API.
    Returns a UTC datetime if found.
    """
    # Event details usually include competitions; competition payload often carries tee times.
    event_url = f"{ESPN_CORE_BASE}/events/{event_id}"
    event = espn_get_json_url(event_url)

    comp_urls: List[str] = []
    competitions = event.get("competitions")
    if isinstance(competitions, list):
        for c in competitions:
            if isinstance(c, dict) and isinstance(c.get("$ref"), str):
                comp_urls.append(str(c["$ref"]))
            elif isinstance(c, str) and c.startswith("http"):
                comp_urls.append(c)

    # Prefer first competition; if none, fall back to scanning event itself.
    payloads: List[Any] = []
    if comp_urls:
        payloads.append(espn_get_json_url(comp_urls[0]))
    payloads.append(event)

    candidates: List[datetime] = []
    for p in payloads:
        for s in _iter_candidate_time_strings(p):
            dt = _try_parse_iso_datetime(s)
            if dt is None:
                continue
            candidates.append(dt.astimezone(ZoneInfo("UTC")))

    if not candidates:
        return None
    return min(candidates)


def pick_primary_event(events_payload: Dict[str, Any]) -> Dict[str, Any]:
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

    return primary


def compute_open_lock_from_start(start_iso: Optional[str]) -> Tuple[datetime, datetime]:
    """
    Given ESPN start date (ISO-ish, often '2026-04-23T04:00Z'), compute:
    - open_at: Monday 8:00 AM ET of tournament week
    - lock_at: Thursday 4:00 AM ET of tournament week
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
    thursday = (monday + timedelta(days=3)).replace(hour=4, minute=0, second=0, microsecond=0)
    return (monday, thursday)


def ensure_current_tournament(sb: Client) -> Tuple[str, str]:
    """
    Ensure a tournament exists for ESPN's current/primary PGA event and return (tournament_id, espn_event_id).
    """
    events_payload = espn_get_events(league="pga")
    primary = pick_primary_event(events_payload)
    espn_event_id = str(primary["id"])
    name = str(primary["name"])
    start_date = primary.get("date") if isinstance(primary.get("date"), str) else None
    end_date = primary.get("endDate") if isinstance(primary.get("endDate"), str) else None
    open_at_et, lock_at_et = compute_open_lock_from_start(start_date)

    first_tee_at_utc: Optional[str] = None
    try:
        first_tee_dt = compute_first_tee_time_utc_from_core(espn_event_id)
        if first_tee_dt is not None:
            first_tee_at_utc = first_tee_dt.isoformat()
    except Exception:
        # Tee times may not be published yet; fall back below.
        first_tee_at_utc = None

    if first_tee_at_utc is None and start_date:
        s = start_date.replace("Z", "+00:00")
        first_tee_at_utc = datetime.fromisoformat(s).astimezone(ZoneInfo("UTC")).isoformat()

    starts_at_utc = first_tee_at_utc
    ends_at_utc: Optional[str] = None
    if end_date:
        e = end_date.replace("Z", "+00:00")
        ends_at_utc = datetime.fromisoformat(e).astimezone(ZoneInfo("UTC")).isoformat()

    sb.table("tournaments").upsert(
        {
            "name": name,
            "espn_event_id": espn_event_id,
            "open_at": open_at_et.astimezone(ZoneInfo("UTC")).isoformat(),
            "lock_at": lock_at_et.astimezone(ZoneInfo("UTC")).isoformat(),
            "first_tee_at": first_tee_at_utc,
            "starts_at": starts_at_utc,
            "ends_at": ends_at_utc,
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
    - "MC"  => status="CUT", is_cut=False, total_score=None
    - "WD"/"DQ" => status="WD"/"DQ", is_cut=False, total_score=None
    - "-" / "--" / None => no score yet (total_score=None, status=None, is_cut=None)
    """
    if score_str is None:
        return (None, None, None)

    s = score_str.strip().upper()
    if s in ("", "--"):
        return (None, None, None)
    if s in ("-",):
        # ESPN often uses "-" early in rounds / before teeing off. This is not a cut.
        return (None, None, None)
    if s in ("MC",):
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


def extract_competitor_score_display(row: Dict[str, Any]) -> Optional[str]:
    """ESPN often returns score as {"value": 142.0, "displayValue": "-2"} — use displayValue for rel-to-par."""
    for key in ("score", "displayScore", "totalScore"):
        obj = row.get(key)
        if isinstance(obj, dict):
            dv = obj.get("displayValue")
            if isinstance(dv, str) and dv.strip():
                return dv
        elif isinstance(obj, str) and obj.strip():
            return obj
    return None


def today_score_from_linescores(linescores: Any) -> Optional[int]:
    """Latest round's rel-to-par: highest period with a parseable displayValue on linescores."""
    if not isinstance(linescores, list):
        return None
    best_period = 0
    out: Optional[int] = None
    for ls in linescores:
        if not isinstance(ls, dict):
            continue
        period_raw = ls.get("period")
        if not isinstance(period_raw, int) or period_raw < 1 or period_raw > 4:
            continue
        display = ls.get("displayValue")
        if not isinstance(display, str) or not display.strip():
            continue
        rel, _st, _cut = parse_total_score(display)
        if rel is None:
            continue
        if period_raw >= best_period:
            best_period = period_raw
            out = rel
    return out


@dataclass(frozen=True)
class GolferUpdate:
    espn_athlete_id: str
    name: str
    r1_score: Optional[int]
    r2_score: Optional[int]
    r3_score: Optional[int]
    r4_score: Optional[int]
    total_score: Optional[int]
    today_score: Optional[int]
    current_round: Optional[int]
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

    score_display = extract_competitor_score_display(row)
    total_score, score_status, score_is_cut = parse_total_score(score_display)

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

    linescores = row.get("linescores")
    round_scores: Dict[int, int] = {}
    current_round_ip: Optional[int] = None
    if isinstance(linescores, list):
        for ls in linescores:
            if not isinstance(ls, dict):
                continue
            period_raw = ls.get("period")
            if not isinstance(period_raw, int):
                continue
            if period_raw < 1 or period_raw > 4:
                continue

            in_sc = ls.get("inScore")
            out_sc = ls.get("outScore")
            both_halves = isinstance(in_sc, (int, float)) and isinstance(out_sc, (int, float))
            value = ls.get("value")

            if both_halves:
                if isinstance(value, (int, float)):
                    round_scores[period_raw] = int(value)
                else:
                    try:
                        round_scores[period_raw] = int(in_sc) + int(out_sc)
                    except (TypeError, ValueError):
                        if period_raw >= (current_round_ip or 0):
                            current_round_ip = period_raw
            else:
                if period_raw >= (current_round_ip or 0):
                    current_round_ip = period_raw

    # Weekend rounds implies made cut.
    if is_cut is None and isinstance(linescores, list) and len(linescores) >= 3:
        is_cut = True

    # Missed cut / withdrawn / disqualified are explicit "out" statuses.
    if is_cut is None and status_text:
        st = status_text.strip().upper()
        if st in ("CUT", "WD", "DQ"):
            is_cut = False

    today_rel = today_score_from_linescores(linescores)

    thru = row.get("thru") or row.get("displayThru") or row.get("through")
    if not isinstance(thru, str):
        thru = None

    return GolferUpdate(
        espn_athlete_id=str(athlete_id),
        name=str(name),
        r1_score=round_scores.get(1),
        r2_score=round_scores.get(2),
        r3_score=round_scores.get(3),
        r4_score=round_scores.get(4),
        total_score=total_score,
        today_score=today_rel,
        current_round=current_round_ip,
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
    sb: Optional[Client] = None
    if create_client is not None:
        sb = create_client(supabase_url, service_key)

    tournament_id: Optional[str] = args.tournament_id
    espn_event_id: Optional[str] = args.espn_event_id

    if not tournament_id or not espn_event_id:
        if args.mode != "current":
            raise RuntimeError("Provide --tournament-id and --espn-event-id, or use --mode current")

        if sb is None:
            raise RuntimeError(
                "Python `supabase` dependency missing and explicit ids were not provided. "
                "Run with --tournament-id and --espn-event-id."
            )

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

    # Heuristic: only call the cut "complete" once we have evidence weekend play has begun.
    # This prevents early/placeholder markers from incorrectly locking the tournament into post-cut mode.
    any_weekend_started = any(
        (u.current_round is not None and u.current_round >= 3) or (u.r3_score is not None) or (u.r4_score is not None)
        for u in updates
    )
    any_explicit_cut = any(((u.status or "").strip().upper() == "CUT") and (u.is_cut is False) for u in updates)
    cut_complete = any_weekend_started and any_explicit_cut

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
            "r1_score": u.r1_score,
            "r2_score": u.r2_score,
            "r3_score": u.r3_score,
            "r4_score": u.r4_score,
            "total_score": u.total_score,
            "today_score": u.today_score,
            "current_round": u.current_round,
            "thru": u.thru,
            "status": u.status,
            "is_cut": u.is_cut,
        }
        golfer_rows.append(row)

    if sb is not None:
        sb.table("golfers").upsert(golfer_rows, on_conflict="tournament_id,espn_athlete_id").execute()
    else:
        # Direct REST fallback: works without supabase-py.
        headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }
        url = f"{supabase_url}/rest/v1/golfers?on_conflict=tournament_id,espn_athlete_id"
        r = requests.post(url, headers=headers, json=golfer_rows, timeout=30)
        r.raise_for_status()

    # Update tournament flags.
    t_patch: Dict[str, Any] = {}
    if tournament_status in ("Live", "Complete"):
        t_patch["status"] = tournament_status
    if cut_complete:
        t_patch["cut_complete"] = True
    if t_patch:
        if sb is not None:
            sb.table("tournaments").update(t_patch).eq("id", tournament_id).execute()
        else:
            headers = {
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
            }
            url = f"{supabase_url}/rest/v1/tournaments?id=eq.{tournament_id}"
            r = requests.patch(url, headers=headers, json=t_patch, timeout=30)
            r.raise_for_status()

    print(f"Synced {len(updates)} golfers for tournament_id={tournament_id}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        raise

