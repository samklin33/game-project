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
TIER_LABELS = {"easy": "簡單", "medium": "中等", "hard": "巷弄"}

MIN_LENGTH_M = 150  # prompt-pool floor for roads (game-side mirror in stats)
MIN_LANE_LENGTH_M = 100  # prompt-pool floor for 巷弄 in 極難

# 忠孝東路一段 → base 忠孝東路, section 一段. Chinese numerals up to 十九
# cover every real case; half/full-width digits guard odd tagging.
SECTION_RE = re.compile(r"^(.+?)([一二三四五六七八九十]+|[0-9]+)段$")

# Not real "find this road" material: bus-only lanes, ramps, frontage
# roads. They also pollute hit-testing by shadowing the road they ride on.
EXCLUDE_RE = re.compile(r"(專用道|匝道|引道|連絡道|聯絡道|側車道|便道|地下車道)")

# 巷/弄 famous enough to be fair game in 困難. Curated; extend freely —
# the build prints which entries matched the OSM data.
FAMOUS_LANES = [
    "永吉路30巷",          # 五分埔商圈
    "和平東路二段118巷",
    "忠孝東路四段216巷",   # 東區美食巷
    "忠孝東路四段553巷",
    "延吉街131巷",
    "永康街6巷",           # 永康商圈
    # wanted but tagged pedestrian in OSM (not fetched): 中華路二段315巷
    # (南機場), 雙城街18巷 (晴光), 師大路39巷 (師大夜市)
]


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
    # One feature per full road name *including* 段, so the game can quiz
    # sections separately in 困難/極難 and group by `base` in 簡單/中等.
    roads: dict[str, dict] = {}
    for el in elements:
        if el.get("type") != "way" or "geometry" not in el:
            continue
        tags = el.get("tags", {})
        raw_name = tags.get("name", "")
        hw = tags.get("highway", "")
        if not raw_name or hw not in TIER_BY_CLASS:
            continue
        full = re.sub(r"\s+", "", unicodedata.normalize("NFKC", raw_name))
        if not full or EXCLUDE_RE.search(full):
            continue
        coords = [[round(pt["lon"], 5), round(pt["lat"], 5)] for pt in el["geometry"]]
        if len(coords) < 2:
            continue
        road = roads.setdefault(full, {"lines": [], "class_length": {}, "length_m": 0.0})
        seg_len = line_length_m(coords)
        road["lines"].append(coords)
        road["length_m"] += seg_len
        road["class_length"][hw] = road["class_length"].get(hw, 0.0) + seg_len

    famous = set(FAMOUS_LANES)
    features = []
    for name, road in roads.items():
        # Tier by dominant highway class (by length) — a road that is 95%
        # residential with one mis-tagged tertiary stub stays residential.
        dominant = max(road["class_length"], key=road["class_length"].get)
        base, section = normalize_name(name)
        props = {
            "name": name,
            "base": base,
            "section": section,
            "tier": TIER_BY_CLASS[dominant],
            "length_m": round(road["length_m"]),
        }
        if re.search(r"[巷弄]", base):
            props["lane"] = True
        if name in famous:
            props["famous"] = True
        features.append(
            {
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "MultiLineString", "coordinates": road["lines"]},
            }
        )
    features.sort(key=lambda f: f["properties"]["name"])

    matched = sorted(famous & set(roads))
    missing = sorted(famous - set(roads))
    print(f"famous lanes matched: {matched}", file=sys.stderr)
    if missing:
        print(f"famous lanes NOT in OSM data (check spelling): {missing}", file=sys.stderr)
    return features


def print_stats(features: list[dict]) -> None:
    """Mirror the frontend's prompt-pool rules so the commit message
    documents what each difficulty actually asks."""
    bases: dict[str, dict] = {}
    for f in features:
        p = f["properties"]
        b = bases.setdefault(
            p["base"], {"len": 0, "lane": bool(p.get("lane")), "tier_len": {}}
        )
        b["len"] += p["length_m"]
        b["tier_len"][p["tier"]] = b["tier_len"].get(p["tier"], 0) + p["length_m"]

    easy = medium = hard = extreme = 0
    for b in bases.values():
        if b["lane"] or b["len"] < MIN_LENGTH_M:
            continue
        medium += 1
        if max(b["tier_len"], key=b["tier_len"].get) == "easy":
            easy += 1
    for f in features:
        p = f["properties"]
        if p.get("lane"):
            if p.get("famous"):
                hard += 1
                extreme += 1
            elif p["length_m"] >= MIN_LANE_LENGTH_M:
                extreme += 1
        elif p["length_m"] >= MIN_LENGTH_M:
            hard += 1
            extreme += 1

    print("\nPrompt pool per difficulty:")
    print(f"  簡單 (easy):    {easy:5d} 幹道")
    print(f"  中等 (medium):  {medium:5d} 道路(不含巷弄)")
    print(f"  困難 (hard):    {hard:5d} 分段道路+知名巷弄")
    print(f"  極難 (extreme): {extreme:5d} 全部(含巷弄)")
    print(f"  Total features: {len(features)} ({len(bases)} base roads)")


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
