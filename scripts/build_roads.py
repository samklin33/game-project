#!/usr/bin/env python3
"""Build the road GeoJSON for 找路 from OpenStreetMap via Overpass.

    python3 scripts/build_roads.py --city 臺北市 --out data/taipei.geojson

One output feature per road *name*: OSM ways are grouped by normalized
name (whitespace stripped, full-width unified, 段 suffixes folded into
the parent road) into a MultiLineString. Section suffixes are preserved
in properties.sections for a future hint feature.
"""

import argparse
import gzip
import io
import json
import math
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

QUERY_TEMPLATE = """\
[out:json][timeout:180];
area["name"="{city}"]["admin_level"="4"]->.city;
way(area.city)["highway"~"^(trunk|primary|secondary|tertiary|residential|unclassified)$"]["name"];
out geom;
"""

# SPEC §1: 簡單 = arterials, 中等 = district roads, 困難 = 巷弄 hell.
TIER_BY_CLASS = {
    "trunk": "easy",
    "primary": "easy",
    "secondary": "medium",
    "tertiary": "medium",
    "residential": "hard",
    "unclassified": "hard",
}
TIER_LABELS = {"easy": "簡單", "medium": "中等", "hard": "困難"}
TIER_ORDER = ["easy", "medium", "hard"]

MIN_LENGTH_M = 150  # untappable specks, dropped from easy/medium only

# 忠孝東路一段 → base 忠孝東路, section 一段. Chinese numerals up to 十九
# cover every real case; half/full-width digits guard odd tagging.
SECTION_RE = re.compile(r"^(.+?)([一二三四五六七八九十]+|[0-9]+)段$")


def normalize_name(raw: str) -> tuple[str, str | None]:
    """Return (base_name, section) with section like 一段, or None."""
    name = unicodedata.normalize("NFKC", raw)
    name = re.sub(r"\s+", "", name)
    m = SECTION_RE.match(name)
    if m:
        return m.group(1), m.group(2) + "段"
    return name, None


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def line_length_m(coords: list[list[float]]) -> float:
    return sum(
        haversine_m(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1])
        for i in range(len(coords) - 1)
    )


def fetch_overpass(city: str) -> dict:
    query = QUERY_TEMPLATE.format(city=city)
    data = urllib.parse.urlencode({"data": query}).encode()
    last_err: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(3):
            try:
                print(f"Querying {endpoint} (attempt {attempt + 1})...", file=sys.stderr)
                req = urllib.request.Request(
                    endpoint,
                    data=data,
                    headers={
                        "User-Agent": "zhao-lu-road-game/0.1 (build_roads.py)",
                        "Accept-Encoding": "gzip",
                    },
                )
                with urllib.request.urlopen(req, timeout=300) as resp:
                    body = resp.read()
                    if resp.headers.get("Content-Encoding") == "gzip":
                        body = gzip.GzipFile(fileobj=io.BytesIO(body)).read()
                    print(f"Received {len(body) / 1e6:.1f} MB", file=sys.stderr)
                    return json.loads(body)
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
                last_err = e
                wait = 2 ** (attempt + 1)
                print(f"  failed: {e}; retrying in {wait}s", file=sys.stderr)
                time.sleep(wait)
    raise SystemExit(f"All Overpass endpoints failed: {last_err}")


def build_features(elements: list[dict]) -> list[dict]:
    # name → accumulated road
    roads: dict[str, dict] = {}
    for el in elements:
        if el.get("type") != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        raw_name = tags.get("name", "")
        hw = tags.get("highway", "")
        if not raw_name or hw not in TIER_BY_CLASS:
            continue
        base, section = normalize_name(raw_name)
        if not base:
            continue
        coords = [[round(pt["lon"], 5), round(pt["lat"], 5)] for pt in el["geometry"]]
        if len(coords) < 2:
            continue
        road = roads.setdefault(
            base,
            {"lines": [], "sections": set(), "class_length": {}, "length_m": 0.0},
        )
        seg_len = line_length_m(coords)
        road["lines"].append(coords)
        road["length_m"] += seg_len
        road["class_length"][hw] = road["class_length"].get(hw, 0.0) + seg_len
        if section:
            road["sections"].add(section)

    features = []
    for name, road in roads.items():
        # Tier by dominant highway class (by length) — a road that is 95%
        # residential with one mis-tagged tertiary stub stays 困難.
        dominant = max(road["class_length"], key=road["class_length"].get)
        tier = TIER_BY_CLASS[dominant]
        length = round(road["length_m"])
        if tier in ("easy", "medium") and length < MIN_LENGTH_M:
            continue
        props = {"name": name, "tier": tier, "length_m": length}
        if road["sections"]:
            props["sections"] = sorted(road["sections"])
        features.append(
            {
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "MultiLineString", "coordinates": road["lines"]},
            }
        )
    features.sort(key=lambda f: f["properties"]["name"])
    return features


def print_stats(features: list[dict]) -> None:
    counts = {t: 0 for t in TIER_ORDER}
    for f in features:
        counts[f["properties"]["tier"]] += 1
    print("\nRoad count per tier (cumulative = what the player faces):")
    cumulative = 0
    for tier in TIER_ORDER:
        cumulative += counts[tier]
        print(f"  {TIER_LABELS[tier]} ({tier}): {counts[tier]:5d} new, {cumulative:5d} total in tier")
    print(f"  Total roads: {len(features)}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--city", default="臺北市", help="city name as tagged in OSM")
    ap.add_argument("--out", default="data/taipei.geojson", help="output GeoJSON path")
    args = ap.parse_args()

    raw = fetch_overpass(args.city)
    print(f"Overpass returned {len(raw.get('elements', []))} ways", file=sys.stderr)
    features = build_features(raw.get("elements", []))

    geojson = {"type": "FeatureCollection", "features": features}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {args.out}", file=sys.stderr)
    print_stats(features)


if __name__ == "__main__":
    main()
