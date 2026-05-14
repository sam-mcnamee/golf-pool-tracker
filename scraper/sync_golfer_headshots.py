#!/usr/bin/env python3

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import unicodedata
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from supabase import Client, create_client

PGA_PLAYERS_URL = "https://www.pgatour.com/players"
LIV_PLAYERS_URL = "https://www.livgolf.com/standings/2026/players"
PLACEHOLDER_HEADSHOT_URL = "/golfer-placeholder.png"
USER_AGENT = "Mozilla/5.0 (compatible; golf-pool-tracker/1.0; +https://github.com/sam-mcnamee/golf-pool-tracker)"
ABBREVIATED_NAME_RE = re.compile(r"^[A-Z]\.\s")
NON_NAME_RE = re.compile(r"[^a-z\s\-']")
TEAM_NAME_HINTS = (
    " gc",
    " golf club",
    " logo",
    " flag",
    " sponsored",
    " aramco",
    " mastercard",
    " hsbc",
)


@dataclass(frozen=True)
class HeadshotRecord:
    normalized_name: str
    display_name: str
    headshot_url: str
    source: str
    pga_tour_player_id: Optional[str] = None
    espn_athlete_id: Optional[str] = None


def supabase_url() -> str:
    return must_env("SUPABASE_URL", fallback="NEXT_PUBLIC_SUPABASE_URL")


def must_env(name: str, *, fallback: Optional[str] = None) -> str:
    value = os.getenv(name)
    if not value and fallback:
        value = os.getenv(fallback)
    if not value:
        names = name if not fallback else f"{name} or {fallback}"
        raise RuntimeError(f"Missing env var: {names}")
    return value


def normalize_name(name: str) -> str:
    folded = unicodedata.normalize("NFKD", name)
    ascii_name = folded.encode("ascii", "ignore").decode("ascii")
    lowered = NON_NAME_RE.sub(" ", ascii_name.lower())
    return re.sub(r"\s+", " ", lowered).strip()


def is_probable_player_name(name: str) -> bool:
    cleaned = re.sub(r"\s+", " ", name.strip())
    if not cleaned:
        return False
    lowered = cleaned.lower()
    if any(hint in lowered for hint in TEAM_NAME_HINTS):
        return False
    parts = [part for part in cleaned.split(" ") if part]
    if len(parts) < 2:
        return False
    return all(re.fullmatch(r"[A-Za-z][A-Za-z\-']*", part) for part in parts)


def is_abbreviated_name(name: str) -> bool:
    return bool(ABBREVIATED_NAME_RE.match(name.strip()))


def liv_portrait_url(url: str) -> str:
    parsed = urlparse(html.unescape(url))
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["w"] = "256"
    query["h"] = "256"
    query["fit"] = "crop"
    query["auto"] = "format"
    query["q"] = "80"
    return urlunparse(parsed._replace(query=urlencode(query)))


def fetch_pga_headshots(session: requests.Session) -> Dict[str, HeadshotRecord]:
    response = session.get(PGA_PLAYERS_URL, timeout=60)
    response.raise_for_status()
    match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', response.text)
    if not match:
        raise RuntimeError("PGA TOUR players page did not include __NEXT_DATA__")

    payload = json.loads(match.group(1))
    queries = payload["props"]["pageProps"]["dehydratedState"]["queries"]
    players: List[Dict[str, Any]] = []
    for query in queries:
        if query.get("queryKey", [None])[0] == "playerDirectory":
            data = query.get("state", {}).get("data") or {}
            players = data.get("players") or []
            break

    if not players:
        raise RuntimeError("PGA TOUR playerDirectory payload was empty")

    out: Dict[str, HeadshotRecord] = {}
    for player in players:
        display_name = str(player.get("displayName") or "").strip()
        headshot_url = str(player.get("headshot") or "").strip()
        if not display_name or not headshot_url:
            continue
        normalized = normalize_name(display_name)
        if not normalized:
            continue
        out[normalized] = HeadshotRecord(
            normalized_name=normalized,
            display_name=display_name,
            headshot_url=headshot_url,
            source="pgatour",
            pga_tour_player_id=str(player.get("id") or "").strip() or None,
        )
    return out


def fetch_liv_headshots(session: requests.Session) -> Dict[str, HeadshotRecord]:
    response = session.get(LIV_PLAYERS_URL, timeout=60)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")

    candidates: Dict[str, Tuple[str, str]] = {}
    for image in soup.find_all("img"):
        display_name = (image.get("alt") or "").strip()
        if not is_probable_player_name(display_name):
            continue

        srcset = image.get("srcset") or ""
        src = image.get("src") or ""
        raw_url = srcset.split(",")[0].strip().split(" ")[0] if srcset else src
        headshot_url = html.unescape(raw_url)
        if "cdn.sanity.io/images" not in headshot_url:
            continue

        normalized = normalize_name(display_name)
        if not normalized:
            continue

        existing = candidates.get(normalized)
        if existing is None or len(display_name) > len(existing[0]):
            candidates[normalized] = (display_name, liv_portrait_url(headshot_url))

    out: Dict[str, HeadshotRecord] = {}
    for normalized, (display_name, headshot_url) in candidates.items():
        if is_abbreviated_name(display_name):
            continue
        out[normalized] = HeadshotRecord(
            normalized_name=normalized,
            display_name=display_name,
            headshot_url=headshot_url,
            source="livgolf",
        )
    return out


def merge_sources(
    pga: Dict[str, HeadshotRecord],
    liv: Dict[str, HeadshotRecord],
) -> Dict[str, HeadshotRecord]:
    merged = dict(pga)
    for normalized, record in liv.items():
        if normalized not in merged:
            merged[normalized] = record
    return merged


def attach_espn_ids(records: Dict[str, HeadshotRecord], golfers: Iterable[Dict[str, Any]]) -> Dict[str, HeadshotRecord]:
    espn_by_name: Dict[str, str] = {}
    for golfer in golfers:
        name = str(golfer.get("name") or "").strip()
        athlete_id = str(golfer.get("espn_athlete_id") or "").strip()
        if not name or not athlete_id:
            continue
        normalized = normalize_name(name)
        if normalized and normalized not in espn_by_name:
            espn_by_name[normalized] = athlete_id

    updated: Dict[str, HeadshotRecord] = {}
    for normalized, record in records.items():
        athlete_id = espn_by_name.get(normalized)
        updated[normalized] = HeadshotRecord(
            normalized_name=record.normalized_name,
            display_name=record.display_name,
            headshot_url=record.headshot_url,
            source=record.source,
            pga_tour_player_id=record.pga_tour_player_id,
            espn_athlete_id=athlete_id or record.espn_athlete_id,
        )
    return updated


def ensure_pool_golfers_have_rows(
    records: Dict[str, HeadshotRecord],
    golfers: Iterable[Dict[str, Any]],
) -> Dict[str, HeadshotRecord]:
    out = dict(records)
    for golfer in golfers:
        display_name = str(golfer.get("name") or "").strip()
        if not display_name:
            continue
        normalized = normalize_name(display_name)
        if not normalized or normalized in out:
            continue
        athlete_id = str(golfer.get("espn_athlete_id") or "").strip() or None
        out[normalized] = HeadshotRecord(
            normalized_name=normalized,
            display_name=display_name,
            headshot_url=PLACEHOLDER_HEADSHOT_URL,
            source="placeholder",
            espn_athlete_id=athlete_id,
        )
    return out


def chunked(items: List[Dict[str, Any]], size: int) -> Iterable[List[Dict[str, Any]]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def upsert_headshots(sb: Client, records: Dict[str, HeadshotRecord], *, dry_run: bool) -> int:
    rows = [
        {
            "normalized_name": record.normalized_name,
            "display_name": record.display_name,
            "headshot_url": record.headshot_url,
            "source": record.source,
            "pga_tour_player_id": record.pga_tour_player_id,
            "espn_athlete_id": record.espn_athlete_id,
        }
        for record in records.values()
    ]
    if dry_run:
        return len(rows)

    for batch in chunked(rows, 500):
        sb.table("golfer_headshots").upsert(batch, on_conflict="normalized_name").execute()
    return len(rows)


def fetch_pool_golfers(sb: Client) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    page_size = 1000
    offset = 0
    while True:
        response = (
            sb.table("golfers")
            .select("name,espn_athlete_id")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        batch = response.data or []
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < page_size:
            break
        offset += page_size
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync golfer headshots from PGA TOUR and LIV Golf into Supabase.")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and report counts without writing to Supabase")
    args = parser.parse_args()

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    pga = fetch_pga_headshots(session)
    liv = fetch_liv_headshots(session)
    merged = merge_sources(pga, liv)

    if args.dry_run:
        print(f"PGA TOUR headshots: {len(pga)}")
        print(f"LIV Golf headshots: {len(liv)}")
        print(f"Merged unique names: {len(merged)}")
        return 0

    supabase_url_value = supabase_url()
    service_key = must_env("SUPABASE_SERVICE_ROLE_KEY")
    sb = create_client(supabase_url_value, service_key)

    pool_golfers = fetch_pool_golfers(sb)
    merged = attach_espn_ids(merged, pool_golfers)
    merged = ensure_pool_golfers_have_rows(merged, pool_golfers)

    written = upsert_headshots(sb, merged, dry_run=False)
    placeholders = sum(1 for record in merged.values() if record.source == "placeholder")
    print(
        f"Upserted {written} golfer headshots "
        f"(pgatour={len(pga)}, livgolf={len(liv)}, placeholder={placeholders}, pool_golfers={len(pool_golfers)})"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
