#!/usr/bin/env python3

from __future__ import annotations

import os
import re
import sys
import unicodedata
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import requests
from bs4 import BeautifulSoup
from supabase import Client, create_client

from tournament_context import pick_current_tournament


WP_API = "https://dknetwork.draftkings.com/wp-json/wp/v2/posts"


def must_env(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing env var: {name}")
    return v


def http_get_json(url: str, params: Dict[str, Any], timeout_s: int = 20, retries: int = 3) -> Any:
    last: Optional[Exception] = None
    for i in range(retries):
        try:
            r = requests.get(url, params=params, timeout=timeout_s, headers={"accept": "application/json"})
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"Failed GET {url}: {last}")


def http_get_text(url: str, timeout_s: int = 20, retries: int = 3) -> str:
    last: Optional[Exception] = None
    for i in range(retries):
        try:
            r = requests.get(
                url,
                timeout=timeout_s,
                headers={
                    "accept": "text/html,application/xhtml+xml",
                    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                },
            )
            r.raise_for_status()
            return r.text
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"Failed GET {url}: {last}")


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


@dataclass(frozen=True)
class OddsRow:
    name: str
    odds_american: int


ODDS_RE = re.compile(
    r"(?P<name>[A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\\s+[A-Za-zÀ-ÖØ-öø-ÿ'’.-]+)+)\\s+\\+?(?P<odds>\\d{2,6})\\b"
)

BULLET_RE = re.compile(r"^[\\-\\*]\\s*(?P<name>.+?)\\s+\\+?(?P<odds>\\d{2,6})\\s*$")


def parse_odds_from_html(html: str) -> List[OddsRow]:
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text("\n")
    rows: List[OddsRow] = []

    # 1) Prefer bullet list lines like "- Scottie Scheffler +295"
    for line in (ln.strip() for ln in text.splitlines()):
        if "+" not in line:
            continue
        bm = BULLET_RE.match(line)
        if bm:
            name = bm.group("name").strip()
            odds = int(bm.group("odds"))
            if len(name) >= 6:
                rows.append(OddsRow(name=name, odds_american=odds))
            continue

        m = ODDS_RE.search(line)
        if m:
            name = m.group("name").strip()
            odds = int(m.group("odds"))
            if len(name) >= 6:
                rows.append(OddsRow(name=name, odds_american=odds))

    # 2) Fallback: scan entire text in case the page is compressed into fewer lines
    if not rows:
        for m in ODDS_RE.finditer(text):
            name = m.group("name").strip()
            odds = int(m.group("odds"))
            if len(name) >= 6:
                rows.append(OddsRow(name=name, odds_american=odds))

    # Deduplicate by normalized name, keep best (lowest) odds
    best: Dict[str, OddsRow] = {}
    for r in rows:
        k = normalize_name(r.name)
        prev = best.get(k)
        if prev is None or r.odds_american < prev.odds_american:
            best[k] = r

    return sorted(best.values(), key=lambda r: r.odds_american)


def find_full_field_post(tournament_name: str) -> Tuple[str, str]:
    # Search for "odds, full field" article; pick most recent.
    q = f"{tournament_name} odds, full field"
    posts = http_get_json(WP_API, params={"search": q, "per_page": 10, "orderby": "date", "order": "desc", "_embed": "1"})
    if not isinstance(posts, list) or not posts:
        # fallback: drop punctuation / search shorter
        posts = http_get_json(WP_API, params={"search": f"{tournament_name} odds", "per_page": 10, "orderby": "date", "order": "desc"})
    if not isinstance(posts, list) or not posts:
        raise RuntimeError(f"No DK Network posts found for: {tournament_name}")

    # Prefer titles containing "full field"
    def title(p: Dict[str, Any]) -> str:
        t = p.get("title", {})
        return t.get("rendered") if isinstance(t, dict) else str(t)

    chosen = None
    for p in posts:
        if not isinstance(p, dict):
            continue
        if "full field" in title(p).lower():
            chosen = p
            break
    if chosen is None:
        chosen = posts[0]

    link = str(chosen.get("link"))
    ttl = title(chosen) or link
    return (link, ttl)


def map_odds_to_golfers(sb: Client, tournament_id: str, odds: List[OddsRow]) -> List[Dict[str, Any]]:
    # Build name->golfer_id map from golfers table
    gq = sb.table("golfers").select("id,name").eq("tournament_id", tournament_id).execute()
    golfers = gq.data or []
    id_by_norm: Dict[str, str] = {}
    for g in golfers:
        id_by_norm[normalize_name(g["name"])] = g["id"]

    out: List[Dict[str, Any]] = []
    now = datetime.now(timezone.utc).isoformat()
    for r in odds:
        gid = id_by_norm.get(normalize_name(r.name))
        out.append(
            {
                "tournament_id": tournament_id,
                "golfer_id": gid,
                "golfer_name": r.name,
                "odds_american": r.odds_american,
                "source": "dknetwork",
                "fetched_at": now,
            }
        )
    return out


def main() -> int:
    supabase_url = must_env("SUPABASE_URL")
    service_key = must_env("SUPABASE_SERVICE_ROLE_KEY")
    sb: Client = create_client(supabase_url, service_key)

    t = pick_current_tournament(sb)
    tournament_id = t["id"]
    tournament_name = t["name"]

    url, title = find_full_field_post(tournament_name)
    html = http_get_text(url)
    odds = parse_odds_from_html(html)

    if len(odds) < 20:
        # DK Network sometimes serves different content to servers/bots.
        # Don't fail the workflow; just log and try again on the next scheduled run.
        snippet = re.sub(r"\\s+", " ", html[:500])
        print(f"WARNING: Parsed too few odds rows ({len(odds)}) from post: {title} ({url})")
        print(f"WARNING: HTML snippet: {snippet}")
        return 0

    rows = map_odds_to_golfers(sb, tournament_id, odds)

    # Upsert into latest table (unique on tournament_id+golfer_name)
    sb.table("tournament_odds_latest").upsert(rows, on_conflict="tournament_id,golfer_name").execute()

    # Store source_url on all rows for traceability (best-effort patch)
    sb.table("tournament_odds_latest").update({"source_url": url}).eq("tournament_id", tournament_id).execute()

    print(f"Imported {len(rows)} DK Network odds rows for {tournament_name}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: {e}", file=sys.stderr)
        raise

