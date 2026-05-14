#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import unicodedata
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
DEBUG_LOG_PATH = "/home/sam/my_new_project/.cursor/debug-0f5852.log"


def _agent_debug_log(
    *,
    hypothesis_id: str,
    location: str,
    message: str,
    data: Dict[str, Any],
    run_id: str = "pre-fix",
) -> None:
    # #region agent log
    try:
        payload = {
            "sessionId": "0f5852",
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data,
            "timestamp": int(time.time() * 1000),
            "runId": run_id,
        }
        with open(DEBUG_LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload) + "\n")
    except Exception:
        pass
    # #endregion


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


def _to_utc(dt: datetime) -> datetime:
    return dt.astimezone(ZoneInfo("UTC"))


def _parse_db_ts(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return _to_utc(value)
    if isinstance(value, str) and value.strip():
        parsed = _try_parse_iso_datetime(value)
        if parsed is not None:
            return _to_utc(parsed)
    return None


def earliest_round1_tee_utc_from_competitors(competitors: List[Any]) -> Optional[datetime]:
    """Earliest Round 1 tee time from ESPN site leaderboard competitor rows."""
    candidates: List[datetime] = []
    for row in competitors:
        if not isinstance(row, dict):
            continue

        linescores = row.get("linescores")
        if isinstance(linescores, list):
            for ls in linescores:
                if not isinstance(ls, dict):
                    continue
                if ls.get("period") != 1:
                    continue
                tee_time = ls.get("teeTime")
                if isinstance(tee_time, str):
                    dt = _try_parse_iso_datetime(tee_time)
                    if dt is not None:
                        candidates.append(_to_utc(dt))

        status_obj = row.get("status")
        if isinstance(status_obj, dict) and _parse_int_round(status_obj.get("period")) == 1:
            tee_time = status_obj.get("teeTime")
            if isinstance(tee_time, str):
                dt = _try_parse_iso_datetime(tee_time)
                if dt is not None:
                    candidates.append(_to_utc(dt))

    if not candidates:
        return None
    return min(candidates)


def _should_advance_first_tee_at(earliest: datetime, existing: Optional[datetime]) -> bool:
    if existing is None:
        return True
    return _to_utc(earliest) < _to_utc(existing)


def resolve_first_tee_at_for_upsert(
    *,
    earliest: Optional[datetime],
    existing_first_tee_at: Any,
    starts_at_utc: Optional[str],
) -> Tuple[Optional[str], Optional[str]]:
    existing = _parse_db_ts(existing_first_tee_at)
    if earliest is not None and _should_advance_first_tee_at(earliest, existing):
        first_iso = _to_utc(earliest).isoformat()
        return first_iso, first_iso
    if existing is not None:
        ex_iso = _to_utc(existing).isoformat()
        return ex_iso, starts_at_utc or ex_iso
    return None, starts_at_utc


def maybe_update_tournament_first_tee_from_competitors(
    sb: Optional[Client],
    supabase_url: str,
    service_key: str,
    tournament_id: str,
    competitors: List[Any],
    *,
    dry_run: bool,
) -> None:
    earliest = earliest_round1_tee_utc_from_competitors(competitors)
    if earliest is None:
        return

    if sb is not None:
        sel = sb.table("tournaments").select("status,first_tee_at").eq("id", tournament_id).limit(1).execute()
        row = (sel.data or [None])[0]
    else:
        headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
        }
        url = f"{supabase_url}/rest/v1/tournaments?id=eq.{tournament_id}&select=status,first_tee_at"
        r = requests.get(url, headers=headers, timeout=30)
        r.raise_for_status()
        row = (r.json() or [None])[0]

    if not isinstance(row, dict):
        return
    if row.get("status") not in ("Upcoming", "Open"):
        return

    existing = _parse_db_ts(row.get("first_tee_at"))
    if not _should_advance_first_tee_at(earliest, existing):
        return

    first_iso = _to_utc(earliest).isoformat()
    patch = {"first_tee_at": first_iso, "starts_at": first_iso}
    if dry_run:
        print(json.dumps({"first_tee_update": patch, "tournament_id": tournament_id}))
        return

    if sb is not None:
        sb.table("tournaments").update(patch).eq("id", tournament_id).execute()
    else:
        headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
        }
        url = f"{supabase_url}/rest/v1/tournaments?id=eq.{tournament_id}"
        r = requests.patch(url, headers=headers, json=patch, timeout=30)
        r.raise_for_status()


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

    first_tee_dt: Optional[datetime] = None
    try:
        leaderboard_payload = espn_get_json(espn_event_id)
        first_tee_dt = earliest_round1_tee_utc_from_competitors(extract_competitors(leaderboard_payload))
    except Exception:
        # Tee times may not be published yet; keep any existing first_tee_at.
        first_tee_dt = None

    starts_at_utc: Optional[str] = None
    if start_date:
        s = start_date.replace("Z", "+00:00")
        starts_at_utc = datetime.fromisoformat(s).astimezone(ZoneInfo("UTC")).isoformat()

    ends_at_utc: Optional[str] = None
    if end_date:
        e = end_date.replace("Z", "+00:00")
        ends_at_utc = datetime.fromisoformat(e).astimezone(ZoneInfo("UTC")).isoformat()

    existing_sel = sb.table("tournaments").select("first_tee_at").eq("espn_event_id", espn_event_id).limit(1).execute()
    existing_first_tee_at = (existing_sel.data or [None])[0]
    existing_first_tee_at = (
        existing_first_tee_at.get("first_tee_at") if isinstance(existing_first_tee_at, dict) else None
    )

    first_tee_at_utc, starts_at_utc = resolve_first_tee_at_for_upsert(
        earliest=first_tee_dt,
        existing_first_tee_at=existing_first_tee_at,
        starts_at_utc=starts_at_utc,
    )

    upsert_row: Dict[str, Any] = {
        "name": name,
        "espn_event_id": espn_event_id,
        "open_at": open_at_et.astimezone(ZoneInfo("UTC")).isoformat(),
        "lock_at": lock_at_et.astimezone(ZoneInfo("UTC")).isoformat(),
        "starts_at": starts_at_utc,
        "ends_at": ends_at_utc,
    }
    if first_tee_at_utc is not None:
        upsert_row["first_tee_at"] = first_tee_at_utc

    sb.table("tournaments").upsert(
        upsert_row,
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


_DETAIL_SCORE_RE = re.compile(r"^\s*(?P<score>E|[+-]?\d+)\s*(?:\(|$)", flags=re.I)


def total_score_from_status_detail(status_obj: Any) -> Optional[int]:
    """
    ESPN live leaderboard commonly encodes the live tournament score in status.detail / status.todayDetail
    like '+1(15)' or 'E(14)'. Extract the score portion and parse it as relative-to-par.
    """
    if not isinstance(status_obj, dict):
        return None
    for k in ("detail", "todayDetail"):
        v = status_obj.get(k)
        if not isinstance(v, str) or not v.strip():
            continue
        m = _DETAIL_SCORE_RE.match(v.strip())
        if not m:
            continue
        s = m.group("score").upper()
        rel, _st, _cut = parse_total_score(s)
        if rel is not None:
            return rel
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


def _parse_int_round(obj: Any) -> Optional[int]:
    if isinstance(obj, int):
        return obj if 1 <= obj <= 4 else None
    if isinstance(obj, str):
        s = obj.strip()
        if s.isdigit():
            i = int(s)
            return i if 1 <= i <= 4 else None
    return None


def _thru_state(thru: Optional[str]) -> str:
    """
    Coarse state derived from ESPN's `thru` field.
    Returns: "not_started" | "in_progress" | "finished" | "unknown"
    """
    if not thru:
        return "unknown"
    t = thru.strip().upper()
    if not t:
        return "unknown"

    # Finished markers.
    if t in ("F", "FIN", "FINAL"):
        return "finished"
    if t.startswith("F"):
        # "F", "F1", etc.
        return "finished"

    # Hole number => in progress.
    if t.isdigit():
        n = int(t)
        if 1 <= n <= 18:
            return "in_progress"

    # Tee time patterns like "1:35 PM" or "08:10AM".
    if ":" in t and ("AM" in t or "PM" in t):
        return "not_started"

    return "unknown"


def is_actively_scoring(u: GolferUpdate) -> bool:
    status = (u.status or "").strip().upper()
    if "IN_PROGRESS" in status or status in ("IN", "INPROGRESS", "LIVE"):
        return True
    if u.total_score is not None or u.today_score is not None:
        return True
    thru = (u.thru or "").strip()
    if thru and thru not in ("0", "-", "--"):
        return True
    return False


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
    r1_tee_at: Optional[str]
    r2_tee_at: Optional[str]
    r3_tee_at: Optional[str]
    r4_tee_at: Optional[str]


def extract_competitors(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Returns the leaderboard rows from ESPN, or an empty list when ESPN
    hasn't populated the field yet (common pre-tournament). Callers should
    treat an empty list as "no field available yet" rather than an error."""
    competitors = deep_find_first_list(payload, "competitors")
    if competitors and all(isinstance(x, dict) for x in competitors):
        return competitors  # type: ignore[return-value]

    # Some ESPN payloads use "entries" for leaderboard rows.
    entries = deep_find_first_list(payload, "entries")
    if entries and all(isinstance(x, dict) for x in entries):
        return entries  # type: ignore[return-value]

    return []


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

    # Prefer the live score shown in ESPN status.detail/todayDetail (e.g. '+1(15)') when available.
    total_from_detail = total_score_from_status_detail(status_obj)
    if total_from_detail is not None:
        total_score = total_from_detail

    if score_status:
        status_text = score_status
    if score_is_cut is not None:
        is_cut = score_is_cut

    linescores = row.get("linescores")
    # Round scores should be relative-to-par (same units as total_score).
    round_scores: Dict[int, int] = {}
    round_tee_at: Dict[int, str] = {}
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

            tee_time = ls.get("teeTime")
            if isinstance(tee_time, str):
                tee_dt = _try_parse_iso_datetime(tee_time)
                if tee_dt is not None:
                    round_tee_at[period_raw] = tee_dt.astimezone(ZoneInfo("UTC")).isoformat()

            display = ls.get("displayValue")
            if isinstance(display, str) and display.strip():
                rel, _st, _cut = parse_total_score(display)
                if rel is not None:
                    round_scores[period_raw] = rel

    # Weekend rounds implies made cut.
    if is_cut is None and isinstance(linescores, list) and len(linescores) >= 3:
        is_cut = True

    # Missed cut / withdrawn / disqualified are explicit "out" statuses.
    if is_cut is None and status_text:
        st = status_text.strip().upper()
        if st in ("CUT", "WD", "DQ"):
            is_cut = False

    today_rel = today_score_from_linescores(linescores)

    # ESPN leaderboard payload stores progress in row["status"] (not top-level).
    thru: Optional[str] = None
    if isinstance(status_obj, dict):
        thru_raw = status_obj.get("displayThru") if isinstance(status_obj.get("displayThru"), (str, int, float)) else status_obj.get("thru")
        if isinstance(thru_raw, (int, float)):
            thru = str(int(thru_raw))
        elif isinstance(thru_raw, str):
            thru = thru_raw
    if thru is not None:
        thru = str(thru).strip() or None

    # Determine current round for "IP" display.
    # Prefer explicit round fields if present; otherwise fall back to thru + linescores.
    explicit_round = None
    for k in ("currentRound", "current_round", "round"):
        if k in row:
            explicit_round = _parse_int_round(row.get(k))
            if explicit_round is not None:
                break
    if explicit_round is None and isinstance(status_obj, dict):
        # ESPN commonly provides the current round as status.period (1..4)
        explicit_round = _parse_int_round(status_obj.get("period"))

    if explicit_round is not None:
        current_round_ip = explicit_round
    else:
        state = _thru_state(thru)
        if state == "in_progress":
            # Latest period with parseable displayValue; default to R1 if none.
            best_period = 0
            if isinstance(linescores, list):
                for ls in linescores:
                    if not isinstance(ls, dict):
                        continue
                    period = ls.get("period")
                    if not isinstance(period, int) or period < 1 or period > 4:
                        continue
                    dv = ls.get("displayValue")
                    if not isinstance(dv, str) or not dv.strip():
                        continue
                    rel, _st, _cut = parse_total_score(dv)
                    if rel is None:
                        continue
                    best_period = max(best_period, period)
            current_round_ip = best_period or 1
        else:
            # Not started / finished / unknown => don't mark IP.
            current_round_ip = None

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
        r1_tee_at=round_tee_at.get(1),
        r2_tee_at=round_tee_at.get(2),
        r3_tee_at=round_tee_at.get(3),
        r4_tee_at=round_tee_at.get(4),
    )


def build_sync_health_payload(
    *,
    tournament_id: str,
    espn_event_id: str,
    tournament_status: Optional[str],
    updates: List[GolferUpdate],
    total_from_detail_count: int,
    total_from_fallback_count: int,
    last_error: Optional[str],
    anomalies: List[Dict[str, Any]],
) -> Dict[str, Any]:
    now_iso = datetime.now(ZoneInfo("UTC")).isoformat()
    in_progress = [u for u in updates if is_actively_scoring(u)]
    in_prog_total = len(in_progress)
    null_total_in_prog = sum(1 for u in in_progress if u.total_score is None)
    null_thru_in_prog = sum(1 for u in in_progress if not (u.thru and str(u.thru).strip()))

    health = {
        "tournament_id": tournament_id,
        "espn_event_id": espn_event_id,
        "last_run_at": now_iso,
        "last_error": last_error,
        "golfers_updated_count": len(updates),
        "total_from_detail_count": int(total_from_detail_count),
        "total_from_fallback_count": int(total_from_fallback_count),
        "anomalies": anomalies,
    }

    is_live = tournament_status == "Live"
    # Record last_success_at only when the run had no error and validations pass.
    hard_fail = False
    if is_live and in_prog_total > 0:
        frac_null_total = null_total_in_prog / max(1, in_prog_total)
        frac_null_thru = null_thru_in_prog / max(1, in_prog_total)
        if frac_null_total > 0.2:
            anomalies.append(
                {"type": "too_many_null_totals_in_progress", "count": null_total_in_prog, "total": in_prog_total}
            )
            hard_fail = True
        if frac_null_thru > 0.5:
            anomalies.append({"type": "too_many_null_thru_in_progress", "count": null_thru_in_prog, "total": in_prog_total})
            # Not a hard fail—some events may omit thru for some players.

    if last_error is None and not hard_fail:
        health["last_success_at"] = now_iso

    # #region agent log
    _agent_debug_log(
        hypothesis_id="B",
        location="espn_leaderboard_sync.py:build_sync_health_payload",
        message="sync health validation",
        data={
            "tournamentId": tournament_id,
            "tournamentStatus": tournament_status,
            "isLive": is_live,
            "inProgressTotal": in_prog_total,
            "nullTotalInProgress": null_total_in_prog,
            "hardFail": hard_fail,
            "anomalyTypes": [a.get("type") for a in anomalies],
        },
    )
    # #endregion

    return health


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


def _created_ts_for_sort(row: Dict[str, Any]) -> float:
    raw = row.get("created_at")
    if not raw:
        return 0.0
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).timestamp()
    except Exception:  # noqa: BLE001
        return 0.0


def list_syncable_tournaments(sb: Client) -> List[Dict[str, Any]]:
    """
    All non-Complete tournaments with a numeric ESPN event id.
    Prefer Live, then Locked, Open, Upcoming; newest created_at first within each status.
    """
    q = sb.table("tournaments").select("id,espn_event_id,status,created_at").neq("status", "Complete").execute()
    rows = q.data or []
    out: List[Dict[str, Any]] = []
    for r in rows:
        eid = r.get("espn_event_id")
        if eid is None or not str(eid).strip().isdigit():
            continue
        out.append(r)
    pri = {"Live": 0, "Locked": 1, "Open": 2, "Upcoming": 3}
    out.sort(key=lambda r: (pri.get(str(r.get("status") or ""), 9), -_created_ts_for_sort(r)))
    return out


def sync_leaderboard_once(
    sb: Optional[Client],
    supabase_url: str,
    service_key: str,
    tournament_id: str,
    espn_event_id: str,
    *,
    dry_run: bool,
) -> int:
    payload = espn_get_json(str(espn_event_id))
    competitors = extract_competitors(payload)

    maybe_update_tournament_first_tee_from_competitors(
        sb,
        supabase_url,
        service_key,
        tournament_id,
        competitors,
        dry_run=dry_run,
    )

    updates: List[GolferUpdate] = []
    used_detail = 0
    used_score_display = 0
    for row in competitors:
        if not isinstance(row, dict):
            continue
        status_obj = row.get("status")
        total_from_detail = total_score_from_status_detail(status_obj)
        if total_from_detail is not None:
            used_detail += 1
        else:
            used_score_display += 1
        u = competitor_to_update(row)
        if u is not None:
            updates.append(u)

    if not updates:
        # #region agent log
        _agent_debug_log(
            hypothesis_id="D",
            location="espn_leaderboard_sync.py:sync_leaderboard_once",
            message="no competitors in ESPN payload",
            data={"tournamentId": tournament_id, "espnEventId": espn_event_id},
        )
        # #endregion
        # ESPN often does not publish the competitor list until late in the
        # tournament week (often after first tee times go out). Treat this as
        # a soft success so the pipeline can continue and pull odds without
        # field-matching; the auto-relink path below will reconcile once
        # ESPN populates the field on a later run.
        print(
            f"WARNING: ESPN payload has no competitors yet for event {espn_event_id} "
            f"(tournament_id={tournament_id}); skipping golfer upsert.",
            file=sys.stderr,
        )
        return 0

    if os.getenv("ESPN_SYNC_DEBUG", "").strip():
        focus = {"XANDER SCHAUFFELE", "SAHITH THEEGALA", "TONY FINAU", "AKSHAY BHATIA"}
        print("DEBUG: sample parsed golfer rows (name total today round thru status is_cut r1 r2 r3 r4)")
        shown = 0
        for u in updates:
            n = (u.name or "").strip().upper()
            if n in focus or shown < 10:
                print(
                    f"DEBUG: {u.name} total={u.total_score} today={u.today_score} "
                    f"round={u.current_round} thru={u.thru} status={u.status} is_cut={u.is_cut} "
                    f"r1={u.r1_score} r2={u.r2_score} r3={u.r3_score} r4={u.r4_score}"
                )
                shown += 1
            if shown >= 25:
                break

    tournament_status, _is_final = detect_event_status(payload)

    # Heuristic: only call the cut "complete" once we have evidence weekend play has begun.
    # This prevents early/placeholder markers from incorrectly locking the tournament into post-cut mode.
    any_weekend_started = any(
        (u.current_round is not None and u.current_round >= 3) or (u.r3_score is not None) or (u.r4_score is not None)
        for u in updates
    )
    any_explicit_cut = any(((u.status or "").strip().upper() == "CUT") and (u.is_cut is False) for u in updates)
    cut_complete = any_weekend_started and any_explicit_cut

    if dry_run:
        print(json.dumps({"tournament_id": tournament_id, "espn_event_id": espn_event_id, "count": len(updates)}))
        return 0

    anomalies: List[Dict[str, Any]] = []

    existing_by_athlete: Dict[str, Dict[str, Any]] = {}
    if sb is not None:
        existing_sel = (
            sb.table("golfers")
            .select(
                "espn_athlete_id,r1_tee_at,r2_tee_at,r3_tee_at,r4_tee_at,"
                "r1_score,r2_score,r3_score,r4_score,total_score,today_score"
            )
            .eq("tournament_id", tournament_id)
            .execute()
        )
        for g in existing_sel.data or []:
            athlete_id = g.get("espn_athlete_id")
            if athlete_id is not None:
                existing_by_athlete[str(athlete_id)] = g

    tee_fields = ("r1_tee_at", "r2_tee_at", "r3_tee_at", "r4_tee_at")
    score_fields = ("r1_score", "r2_score", "r3_score", "r4_score", "total_score", "today_score")

    # Upsert golfers into tournament.
    golfer_rows = []
    for u in updates:
        row: Dict[str, Any] = {
            "tournament_id": tournament_id,
            "espn_athlete_id": u.espn_athlete_id,
            "name": u.name,
            "current_round": u.current_round,
            "thru": u.thru,
            "status": u.status,
            "is_cut": u.is_cut,
        }
        prev = existing_by_athlete.get(u.espn_athlete_id, {})
        for key in score_fields:
            val = getattr(u, key)
            if val is None:
                val = prev.get(key)
            if val is not None:
                row[key] = val
        for key in tee_fields:
            val = getattr(u, key)
            if val is None:
                val = prev.get(key)
            if val is not None:
                row[key] = val
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

    # Self-heal: relink golfer_tiers to authoritative golfer rows (by normalized name).
    relinked = 0
    odds_relinked = 0
    if sb is not None:
        try:
            # Build authoritative golfer id per normalized name (prefer rows with score/thru/recent updated_at).
            gq = (
                sb.table("golfers")
                .select("id,name,total_score,today_score,current_round,thru,updated_at")
                .eq("tournament_id", tournament_id)
                .execute()
            )
            golfers = list(gq.data or [])

            def authority_key(g: Dict[str, Any]) -> Tuple[int, int, float]:
                has_score = 1 if any(g.get(k) is not None for k in ("total_score", "today_score", "current_round")) else 0
                has_thru = 1 if isinstance(g.get("thru"), str) and g.get("thru").strip() else 0
                upd = g.get("updated_at") or ""
                try:
                    ts = datetime.fromisoformat(str(upd).replace("Z", "+00:00")).timestamp()
                except Exception:
                    ts = 0.0
                return (has_score, has_thru, ts)

            by_norm: Dict[str, List[Dict[str, Any]]] = {}
            for g in golfers:
                key = normalize_name(str(g.get("name") or ""))
                if key:
                    by_norm.setdefault(key, []).append(g)

            authoritative_by_norm: Dict[str, str] = {}
            for k, group in by_norm.items():
                best = max(group, key=authority_key)
                authoritative_by_norm[k] = str(best["id"])

            tq = (
                sb.table("golfer_tiers")
                .select("id,golfer_id,golfers:golfer_id(id,name)")
                .eq("tournament_id", tournament_id)
                .execute()
            )
            tiers = list(tq.data or [])
            patches: List[Dict[str, Any]] = []
            for tr in tiers:
                g0 = tr.get("golfers")
                if not isinstance(g0, dict):
                    continue
                name = str(g0.get("name") or "")
                norm = normalize_name(name)
                want = authoritative_by_norm.get(norm)
                if not want:
                    continue
                have = tr.get("golfer_id")
                # Fill null golfer_ids and fix wrong ones.
                if have is None or str(have) != want:
                    patches.append({"id": tr["id"], "golfer_id": want})

            if patches:
                # Per-row updates: upsert with a partial payload would try to INSERT first
                # and fail on NOT NULL columns like tournament_id.
                for p in patches:
                    sb.table("golfer_tiers").update({"golfer_id": p["golfer_id"]}).eq("id", p["id"]).execute()
                relinked = len(patches)
                anomalies.append({"type": "auto_relinked_golfer_tiers", "count": relinked})

            # Keep odds rows consistent too (helps freeze tiers / admin views).
            oq = (
                sb.table("tournament_odds_latest")
                .select("id,golfer_id,golfer_name")
                .eq("tournament_id", tournament_id)
                .execute()
            )
            odds_rows = list(oq.data or [])
            odds_patches: List[Dict[str, Any]] = []
            for o in odds_rows:
                name = str(o.get("golfer_name") or "")
                norm = normalize_name(name)
                want = authoritative_by_norm.get(norm)
                if not want:
                    continue
                have = o.get("golfer_id")
                # Fill null golfer_ids and fix wrong ones (covers the common case where odds
                # are scraped before ESPN publishes the field).
                if have is None or str(have) != want:
                    odds_patches.append({"id": o["id"], "golfer_id": want})
            if odds_patches:
                # Per-row updates (see comment above on golfer_tiers).
                for p in odds_patches:
                    sb.table("tournament_odds_latest").update({"golfer_id": p["golfer_id"]}).eq("id", p["id"]).execute()
                odds_relinked = len(odds_patches)
                anomalies.append({"type": "auto_relinked_tournament_odds_latest", "count": odds_relinked})
        except Exception as e:  # noqa: BLE001
            anomalies.append({"type": "auto_relink_failed", "error": str(e)[:240]})

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

    # Update sync_health (best-effort; does not block syncing unless validations fail hard below).
    last_error: Optional[str] = None
    health = build_sync_health_payload(
        tournament_id=str(tournament_id),
        espn_event_id=str(espn_event_id),
        tournament_status=tournament_status,
        updates=updates,
        total_from_detail_count=used_detail,
        total_from_fallback_count=used_score_display,
        last_error=last_error,
        anomalies=anomalies,
    )
    hard_fail = any(a.get("type") == "too_many_null_totals_in_progress" for a in (health.get("anomalies") or []))
    # #region agent log
    _agent_debug_log(
        hypothesis_id="E",
        location="espn_leaderboard_sync.py:sync_leaderboard_once",
        message="sync completed",
        data={
            "tournamentId": tournament_id,
            "espnEventId": espn_event_id,
            "golferRows": len(golfer_rows),
            "withTotalScore": sum(1 for u in updates if u.total_score is not None),
            "hardFail": hard_fail,
            "tournamentStatus": tournament_status,
        },
    )
    # #endregion
    try:
        if sb is not None:
            sb.table("sync_health").upsert(health, on_conflict="tournament_id").execute()
        else:
            headers = {
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal",
            }
            url = f"{supabase_url}/rest/v1/sync_health?on_conflict=tournament_id"
            r = requests.post(url, headers=headers, json=[health], timeout=30)
            r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        print(f"WARNING: Failed to write sync_health: {e}", file=sys.stderr)

    print(f"Synced {len(updates)} golfers for tournament_id={tournament_id}")
    if hard_fail:
        print("ERROR: Sync validations failed (see sync_health.anomalies)", file=sys.stderr)
        if os.getenv("ESPN_SYNC_STRICT", "").strip().lower() in ("1", "true", "yes"):
            return 3
    return 0


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

    if args.tournament_id and args.espn_event_id:
        if sb is None:
            raise RuntimeError("Python `supabase` dependency missing; cannot run with explicit tournament ids.")
        return sync_leaderboard_once(
            sb,
            supabase_url,
            service_key,
            str(args.tournament_id),
            str(args.espn_event_id),
            dry_run=bool(args.dry_run),
        )

    if args.mode != "current":
        raise RuntimeError("Provide --tournament-id and --espn-event-id, or use --mode current")

    if sb is None:
        raise RuntimeError(
            "Python `supabase` dependency missing and explicit ids were not provided. "
            "Run with --tournament-id and --espn-event-id."
        )

    targets = list_syncable_tournaments(sb)
    if not targets:
        tid, eid = ensure_current_tournament(sb)
        targets = [{"id": tid, "espn_event_id": eid}]

    worst = 0
    for t in targets:
        tid = str(t["id"])
        eid = str(t["espn_event_id"])
        print(f"ESPN sync: tournament_id={tid} espn_event_id={eid} status={t.get('status')}")
        rc = sync_leaderboard_once(sb, supabase_url, service_key, tid, eid, dry_run=bool(args.dry_run))
        worst = max(worst, rc)
    return worst


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        raise

