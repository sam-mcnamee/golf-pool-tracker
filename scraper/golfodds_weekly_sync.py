#!/usr/bin/env python3

from __future__ import annotations

import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests
from bs4 import BeautifulSoup
from supabase import Client, create_client


WEEKLY_ODDS_URL = "http://golfodds.com/weekly-odds.html"


def must_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


def http_get_text(url: str, timeout_s: int = 25, retries: int = 3) -> str:
    last: Optional[Exception] = None
    for i in range(retries):
        try:
            r = requests.get(
                url,
                timeout=timeout_s,
                headers={
                    "accept": "text/html,*/*",
                    "user-agent": "Mozilla/5.0 (compatible; GolfPoolBot/1.0; +https://example.invalid)",
                },
            )
            r.raise_for_status()
            return r.text
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"Failed GET {url}: {last}")


def normalize_name(s: str) -> str:
    return re.sub(r"[^a-z]+", " ", s.lower()).strip()


def fractional_to_american(num: int, den: int) -> int:
    if den == 0:
        raise ValueError("bad odds denominator")
    # American odds from fractional odds (positive underdog convention)
    if num >= den:
        return int(round((num / den) * 100))
    return int(round((-100 * den) / num))


@dataclass(frozen=True)
class OddsRow:
    name: str
    odds_american: int


def parse_odds_to_win_table(table: Any) -> List[OddsRow]:
    raw_rows: List[Tuple[str, str]] = []
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < 2:
            continue
        name = tds[0].get_text(" ", strip=True)
        odds_txt = tds[1].get_text(" ", strip=True)
        raw_rows.append((name, odds_txt))

    rows: List[OddsRow] = []
    started = False
    for name, odds_txt in raw_rows:
        if re.search(r"^odds\s+to\s+win", name, flags=re.I):
            started = True
            continue
        if not started:
            continue
        if re.search(r"^tournament\s+matchups", name, flags=re.I):
            break
        if name.lower() in ("field", "the field", "field (all others)"):
            continue

        m = re.match(r"^(\d+)\s*/\s*(\d+)$", odds_txt)
        if not m:
            continue
        num = int(m.group(1))
        den = int(m.group(2))
        rows.append(OddsRow(name=name.replace("\xa0", " "), odds_american=fractional_to_american(num, den)))

    best: Dict[str, OddsRow] = {}
    for r in rows:
        k = normalize_name(r.name)
        prev = best.get(k)
        if prev is None or r.odds_american < prev.odds_american:
            best[k] = r

    return sorted(best.values(), key=lambda rr: rr.odds_american)


def iter_odds_tables_after(headline: Any) -> List[Any]:
    """
    weekly-odds.html often contains multiple \"ODDS to Win\" tables after the main headline.
    Collect them in document order (deduped).
    """
    seen = set()
    tables: List[Any] = []
    node = headline
    for _ in range(20_000):
        node = node.find_next()
        if node is None:
            break
        if getattr(node, "name", None) != "table":
            continue
        if not node.find(string=re.compile(r"ODDS\s+to\s+Win", re.I)):
            continue
        tid = id(node)
        if tid in seen:
            continue
        seen.add(tid)
        tables.append(node)
    return tables


def pick_best_odds_table(tables: List[Any], golfer_names: List[str]) -> Tuple[Any, List[OddsRow]]:
    if not tables:
        raise RuntimeError("No ODDS-to-Win tables found after headline")

    golfer_norm = {normalize_name(n) for n in golfer_names if normalize_name(n)}

    best_table = None
    best_rows: List[OddsRow] = []
    best_hits = -1

    for table in tables[:12]:
        rows = parse_odds_to_win_table(table)
        if len(rows) < 10:
            continue
        hits = sum(1 for r in rows if normalize_name(r.name) in golfer_norm)
        if hits > best_hits:
            best_hits = hits
            best_table = table
            best_rows = rows

    if best_table is None or best_hits < 8:
        # Last resort: take the largest parsed table (usually the PGA Tour field)
        best_len = -1
        for table in tables[:12]:
            rows = parse_odds_to_win_table(table)
            if len(rows) > best_len:
                best_len = len(rows)
                best_table = table
                best_rows = rows

    if best_table is None:
        raise RuntimeError("Failed to parse any ODDS-to-Win tables")

    return best_table, best_rows


def parse_weekly_odds_page(html: str, golfer_names: List[str]) -> List[Tuple[str, List[OddsRow]]]:
    """
    Returns list of (page_title, odds_rows) for each <span class="Headline-orange">...</span> section.
    """
    soup = BeautifulSoup(html, "html.parser")
    heads = soup.select("span.Headline-orange")
    out: List[Tuple[str, List[OddsRow]]] = []

    for h in heads:
        title = h.get_text(" ", strip=True)
        if not title:
            continue

        tables = iter_odds_tables_after(h)
        _, rows = pick_best_odds_table(tables, golfer_names=golfer_names)
        out.append((title, rows))

    return out


def pick_current_tournament(sb: Client) -> Dict[str, Any]:
    # Keep consistent with /admin (latest created tournament) + dknetwork_odds_sync.py
    q = (
        sb.table("tournaments")
        .select("id,name,status")
        .neq("status", "Complete")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = q.data or []
    if not rows:
        raise RuntimeError("No active tournament found in Supabase")
    return rows[0]


def score_title_match(tournament_name: str, page_title: str) -> float:
    a = set(normalize_name(tournament_name).split())
    b = set(normalize_name(page_title).split())
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / max(1, min(len(a), len(b)))


def pick_best_page_section(tournament_name: str, sections: List[Tuple[str, List[OddsRow]]]) -> Tuple[str, List[OddsRow]]:
    if not sections:
        raise RuntimeError("No GolfOdds headline sections parsed from weekly page")

    scored: List[Tuple[float, str, List[OddsRow]]] = []
    for title, odds in sections:
        scored.append((score_title_match(tournament_name, title), title, odds))
    scored.sort(key=lambda x: x[0], reverse=True)

    best_score, best_title, best_odds = scored[0]
    if best_score < 0.34:
        # Reasonable default: first section is usually the primary PGA Tour event on the weekly page.
        return sections[0]

    return (best_title, best_odds)


def best_golfer_match(name: str, golfers: List[Dict[str, Any]]) -> Optional[str]:
    target = normalize_name(name)
    if not target:
        return None

    id_by_norm: Dict[str, str] = {}
    for g in golfers:
        id_by_norm[normalize_name(g["name"])] = g["id"]

    if target in id_by_norm:
        return id_by_norm[target]

    # Token overlap heuristic
    target_tokens = set(target.split())
    best_id: Optional[str] = None
    best_score = 0
    for g in golfers:
        gn = normalize_name(g["name"])
        gtoks = set(gn.split())
        if not gtoks:
            continue
        score = len(target_tokens & gtoks) / max(1, min(len(target_tokens), len(gtoks)))
        if score > best_score:
            best_score = score
            best_id = g["id"]

    # Require a decent overlap to avoid bad matches
    if best_score >= 0.66:
        return best_id
    return None


def main() -> int:
    supabase_url = must_env("SUPABASE_URL")
    service_key = must_env("SUPABASE_SERVICE_ROLE_KEY")
    sb: Client = create_client(supabase_url, service_key)

    t = pick_current_tournament(sb)
    tournament_id = t["id"]
    tournament_name = str(t["name"])

    html = http_get_text(WEEKLY_ODDS_URL)

    gq = sb.table("golfers").select("id,name").eq("tournament_id", tournament_id).execute()
    golfers = gq.data or []
    golfer_names = [str(g["name"]) for g in golfers]

    sections = parse_weekly_odds_page(html, golfer_names=golfer_names)
    page_title, odds = pick_best_page_section(tournament_name, sections)
    if len(odds) < 20:
        print(
            f"WARNING: Parsed too few odds rows ({len(odds)}) for {tournament_name} "
            f"(matched page title: {page_title!r})"
        )
        return 0

    now = datetime.now(timezone.utc).isoformat()
    rows: List[Dict[str, Any]] = []
    for r in odds:
        gid = best_golfer_match(r.name, golfers)
        rows.append(
            {
                "tournament_id": tournament_id,
                "golfer_id": gid,
                "golfer_name": r.name,
                "odds_american": r.odds_american,
                "source": "golfodds",
                "source_url": WEEKLY_ODDS_URL,
                "fetched_at": now,
            }
        )

    sb.table("tournament_odds_latest").upsert(rows, on_conflict="tournament_id,golfer_name").execute()
    print(f"Imported {len(rows)} golfodds rows for {tournament_name} ({tournament_id}) from section {page_title!r}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        raise
