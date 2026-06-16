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
from collections import Counter, defaultdict

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

# District (區) boundaries for the area hint. Taiwan tags 區/鄉/鎮 at
# admin_level 7. `out geom` returns each relation's member ways with
# coordinates, which we stitch into rings for point-in-polygon.
DISTRICT_QUERY_TEMPLATE = """\
[out:json][timeout:180];
area["name"="{city}"]["admin_level"="4"]->.city;
rel(area.city)["admin_level"="7"]["boundary"="administrative"];
out geom;
"""

# Sub-district place names (天母, 木柵, 光華商場…) for a finer area hint.
# suburb + quarter; neighbourhood/village are obscure historical names.
PLACE_QUERY_TEMPLATE = """\
[out:json][timeout:120];
area["name"="{city}"]["admin_level"="4"]->.city;
node(area.city)["place"~"^(suburb|quarter)$"]["name"];
out;
"""

# MRT stations — the most recognizable modern reference points. Used both
# as the primary area hint ("捷運市政府站附近") and to mark central roads
# (near a station) as worth including in 中等 regardless of length/class.
MRT_QUERY_TEMPLATE = """\
[out:json][timeout:120];
area["name"="{city}"]["admin_level"="4"]->.city;
(
  node(area.city)["station"="subway"]["name"];
  node(area.city)["railway"="station"]["subway"="yes"]["name"];
);
out;
"""

MRT_HINT_MAX_M = 600   # show 捷運X站 when a station is this close
MRT_CENTRAL_MAX_M = 400  # road counts as central (→中等) if any part is this close to MRT
AREA_MAX_M = 1500      # suburb/quarter fallback radius

# Modernize / drop obscure historical suburb names.
AREA_RENAME = {"加蚋子": "萬華"}
AREA_DROP = {"後巷尾"}

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
EASY_MIN_M = 1500  # 簡單 = arterial/secondary AND at least this long
MEDIUM_MIN_M = 500  # 中等 floor — drop obscure sub-500m stubs (game-side mirror)

# 忠孝東路一段 → base 忠孝東路, section 一段. Chinese numerals up to 十九
# cover every real case; half/full-width digits guard odd tagging.
SECTION_RE = re.compile(r"^(.+?)([一二三四五六七八九十]+|[0-9]+)段$")

# Not real "find this road" material: bus-only lanes, ramps, frontage
# roads, elevated/underpass doubles of surface roads. They also pollute
# hit-testing by shadowing the road they ride on.
EXCLUDE_RE = re.compile(
    r"(專用道|匝道|引道|連絡道|聯絡道|側車道|便道|地下車道|車行地下道|高架道路|高架橋|戰備"
    r"|機慢車道|慢車道|機車道|自行車道|堤外|河濱|越堤)"
)

# Real roads kept in the data but barred from 簡單/中等 pools (highways,
# tunnels, hill/mountain roads). Mirrors JUNK_NAME in web/src/game.ts.
EASY_EXCLUDE_RE = re.compile(r"(公路|隧道|地下道|高架|戰備|產業道路|登山)")
MEDIUM_RESID_MIN_M = 1000  # 中等 also takes long recognizable residential roads
MEDIUM_MRT_MIN_M = 200  # 中等 also takes short central roads next to an MRT station

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


def fetch_overpass(query: str) -> dict:
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


def _pt_eq(a: list[float], b: list[float], tol: float = 1e-7) -> bool:
    return abs(a[0] - b[0]) < tol and abs(a[1] - b[1]) < tol


def stitch_rings(segments: list[list[list[float]]]) -> list[list[list[float]]]:
    """Join boundary ways (shared endpoints) into closed rings."""
    segs = [list(s) for s in segments if len(s) >= 2]
    rings: list[list[list[float]]] = []
    while segs:
        ring = segs.pop()
        extended = True
        while extended and not _pt_eq(ring[0], ring[-1]):
            extended = False
            for i, s in enumerate(segs):
                if _pt_eq(ring[-1], s[0]):
                    ring.extend(s[1:])
                elif _pt_eq(ring[-1], s[-1]):
                    ring.extend(reversed(s[:-1]))
                elif _pt_eq(ring[0], s[-1]):
                    ring[0:0] = s[:-1]
                elif _pt_eq(ring[0], s[0]):
                    ring[0:0] = list(reversed(s[1:]))
                else:
                    continue
                segs.pop(i)
                extended = True
                break
        rings.append(ring)
    return rings


def point_in_ring(x: float, y: float, ring: list[list[float]]) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def parse_districts(elements: list[dict]) -> list[tuple[str, list[list[list[float]]]]]:
    """[(district_name, [ring, ...]), ...] from admin_level=7 relations."""
    districts = []
    for el in elements:
        if el.get("type") != "relation":
            continue
        name = el.get("tags", {}).get("name")
        if not name:
            continue
        outers = [
            [[pt["lon"], pt["lat"]] for pt in m["geometry"]]
            for m in el.get("members", [])
            if m.get("type") == "way" and m.get("role") == "outer" and m.get("geometry")
        ]
        rings = [r for r in stitch_rings(outers) if len(r) >= 4]
        if rings:
            districts.append((name, rings))
    return districts


def assign_district(
    point: list[float], districts: list[tuple[str, list[list[list[float]]]]]
) -> str | None:
    x, y = point
    for name, rings in districts:
        if any(point_in_ring(x, y, ring) for ring in rings):
            return name
    # Border/precision miss → nearest district by closest ring vertex.
    best, best_d = None, float("inf")
    for name, rings in districts:
        for ring in rings:
            for vx, vy in ring:
                d = (vx - x) ** 2 + (vy - y) ** 2
                if d < best_d:
                    best_d, best = d, name
    return best


def parse_places(elements: list[dict]) -> list[tuple[str, float, float]]:
    """[(name, lon, lat), ...] from place=suburb/neighbourhood/... nodes."""
    places = []
    for el in elements:
        if el.get("type") != "node":
            continue
        name = el.get("tags", {}).get("name")
        if not name or "lon" not in el or "lat" not in el:
            continue
        # Skip 區-named place nodes (they duplicate the 區 hint) and drops.
        if name.endswith("區") or name in AREA_DROP:
            continue
        places.append((AREA_RENAME.get(name, name), el["lon"], el["lat"]))
    return places


def parse_stations(elements: list[dict]) -> list[tuple[str, float, float]]:
    """[(display, lon, lat)] for MRT stations, display like 捷運市政府站."""
    stations = []
    for el in elements:
        if el.get("type") != "node":
            continue
        name = el.get("tags", {}).get("name")
        if name and "lon" in el and "lat" in el:
            display = name if name.endswith("站") else f"捷運{name}站"
            stations.append((display, el["lon"], el["lat"]))
    return stations


def _nearest(point: list[float], pts: list[tuple[str, float, float]]) -> tuple[str | None, float]:
    x, y = point
    best, best_d = None, float("inf")
    for name, px, py in pts:
        d = haversine_m(x, y, px, py)
        if d < best_d:
            best_d, best = d, name
    return best, best_d


def assign_hint(
    point: list[float],
    stations: list[tuple[str, float, float]],
    places: list[tuple[str, float, float]],
) -> str | None:
    """Area label for the rep point: nearest MRT (≤600m) else suburb (≤1.5km)."""
    mrt, mrt_d = _nearest(point, stations)
    if mrt and mrt_d <= MRT_HINT_MAX_M:
        return mrt
    area, area_d = _nearest(point, places)
    return area if area and area_d <= AREA_MAX_M else None


def near_any_station(
    lines: list[list[list[float]]], stations: list[tuple[str, float, float]]
) -> bool:
    """True if any vertex of the road is within MRT_CENTRAL_MAX_M of a station.
    Whole-geometry (not just the rep point) so short roads whose midpoint sits
    at a far end (峨眉街) still register as central."""
    deg = MRT_CENTRAL_MAX_M / 111000 + 0.0005  # bbox prefilter margin
    for line in lines:
        for x, y in line:
            for _, px, py in stations:
                if abs(py - y) <= deg and abs(px - x) <= deg:
                    if haversine_m(x, y, px, py) <= MRT_CENTRAL_MAX_M:
                        return True
    return False


def representative_point(lines: list[list[list[float]]]) -> list[float]:
    """Midpoint of the longest segment — a stable interior-ish point."""
    longest = max(lines, key=line_length_m)
    return longest[len(longest) // 2]


# Connectivity tolerance: with the ±1 neighbour check below, any two
# vertices within this many degrees per axis (~130m) are unioned. Bridges
# OSM gaps in one road without merging same-named roads in different towns.
CLUSTER_CELL_DEG = 0.0012


def cluster_ways(ways: list[dict]) -> list[list[dict]]:
    """Group ways into connected roads. Ways whose vertices fall in the same
    or adjacent grid cell are unioned, so a fragmented-but-continuous road
    (or one across districts, 忠孝東路) stays one, while same-named roads in
    different areas (新北's many 中山路) split apart."""
    n = len(ways)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    cell_owner: dict[tuple[int, int], int] = {}
    for i, w in enumerate(ways):
        cells = {
            (int(pt[0] / CLUSTER_CELL_DEG), int(pt[1] / CLUSTER_CELL_DEG))
            for pt in w["coords"]
        }
        for cx, cy in cells:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    owner = cell_owner.get((cx + dx, cy + dy))
                    if owner is not None:
                        union(i, owner)
        for c in cells:
            cell_owner[c] = i
    groups: dict[int, list[dict]] = defaultdict(list)
    for i, w in enumerate(ways):
        groups[find(i)].append(w)
    return list(groups.values())


def build_features(
    elements: list[dict],
    districts: list[tuple[str, list[list[list[float]]]]] | None = None,
    places: list[tuple[str, float, float]] | None = None,
    stations: list[tuple[str, float, float]] | None = None,
) -> list[dict]:
    # Collect ways per base road (段 stripped), keeping each way separate so
    # we can split a name into its physically-connected roads.
    base_ways: dict[str, list[dict]] = defaultdict(list)
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
        base, section = normalize_name(full)
        base_ways[base].append(
            {"coords": coords, "hw": hw, "name": full, "section": section, "len": line_length_m(coords)}
        )

    famous = set(FAMOUS_LANES)
    matched_famous: set[str] = set()
    features = []
    for base, ways in base_ways.items():
        components = cluster_ways(ways)
        ambiguous = len(components) > 1
        # Disambiguate components of the same name by district (中山路（板橋區）).
        used_dist: Counter = Counter()
        for comp in components:
            district = (
                assign_district(representative_point([w["coords"] for w in comp]), districts)
                if districts
                else None
            )
            suffix = ""
            if ambiguous:
                tag = district or "其他"
                used_dist[tag] += 1
                suffix = f"（{tag}）" if used_dist[tag] == 1 else f"（{tag}{used_dist[tag]}）"

            # One feature per 段 within the component.
            by_name: dict[str, list[dict]] = defaultdict(list)
            for w in comp:
                by_name[w["name"]].append(w)
            for fname, wlist in by_name.items():
                lines = [w["coords"] for w in wlist]
                class_len: dict[str, float] = defaultdict(float)
                for w in wlist:
                    class_len[w["hw"]] += w["len"]
                dominant = max(class_len, key=class_len.get)
                props = {
                    "name": fname + suffix,
                    "base": base + suffix,
                    "section": wlist[0]["section"],
                    "tier": TIER_BY_CLASS[dominant],
                    "length_m": round(sum(w["len"] for w in wlist)),
                }
                if re.search(r"[巷弄]", base):
                    props["lane"] = True
                if fname in famous:
                    props["famous"] = True
                    matched_famous.add(fname)
                if district:
                    props["district"] = district
                if places or stations:
                    rep = representative_point(lines)
                    area = assign_hint(rep, stations or [], places or [])
                    if area:
                        props["area"] = area
                    if stations and near_any_station(lines, stations):
                        props["near_mrt"] = True
                features.append(
                    {
                        "type": "Feature",
                        "properties": props,
                        "geometry": {"type": "MultiLineString", "coordinates": lines},
                    }
                )
    features.sort(key=lambda f: f["properties"]["name"])

    print(f"famous lanes matched: {sorted(matched_famous)}", file=sys.stderr)
    missing = sorted(famous - matched_famous)
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
            p["base"],
            {"len": 0, "lane": bool(p.get("lane")), "tier_len": {}, "near_mrt": False},
        )
        b["len"] += p["length_m"]
        b["tier_len"][p["tier"]] = b["tier_len"].get(p["tier"], 0) + p["length_m"]
        b["near_mrt"] = b["near_mrt"] or bool(p.get("near_mrt"))

    easy = medium = hard = extreme = 0
    for name, b in bases.items():
        if b["lane"] or EASY_EXCLUDE_RE.search(name):
            continue
        in_medium = False
        if max(b["tier_len"], key=b["tier_len"].get) != "hard":
            # proper district roads (幹道/次要/tertiary)
            if b["len"] >= MEDIUM_MIN_M:
                in_medium = True
            if b["len"] >= EASY_MIN_M:
                easy += 1
        elif b["len"] >= MEDIUM_RESID_MIN_M:
            in_medium = True  # long residential roads (內湖路, 迪化街…)
        # central roads next to an MRT station are notable despite length
        if b["near_mrt"] and b["len"] >= MEDIUM_MRT_MIN_M:
            in_medium = True
        if in_medium:
            medium += 1
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

    with_district = sum(1 for f in features if f["properties"].get("district"))
    with_area = sum(1 for f in features if f["properties"].get("area"))
    print("\nPrompt pool per difficulty:")
    print(f"  簡單 (easy):    {easy:5d} 幹道")
    near_mrt = sum(1 for f in features if f["properties"].get("near_mrt"))
    print(f"  中等 (medium):  {medium:5d} 區域道路+長住宅路+捷運站旁(不含巷弄/雜路)")
    print(f"  困難 (hard):    {hard:5d} 分段道路+知名巷弄")
    print(f"  極難 (extreme): {extreme:5d} 全部(含巷弄)")
    print(f"  Total features: {len(features)} ({len(bases)} base roads)")
    print(f"  District hint coverage: {with_district}/{len(features)}")
    print(f"  Area/landmark hint coverage: {with_area}/{len(features)}")
    print(f"  Near-MRT features: {near_mrt}/{len(features)}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--city", default="臺北市", help="city name as tagged in OSM")
    ap.add_argument("--out", default="data/taipei.geojson", help="output GeoJSON path")
    args = ap.parse_args()

    raw = fetch_overpass(QUERY_TEMPLATE.format(city=args.city))
    print(f"Overpass returned {len(raw.get('elements', []))} ways", file=sys.stderr)

    districts: list[tuple[str, list[list[list[float]]]]] = []
    try:
        draw = fetch_overpass(DISTRICT_QUERY_TEMPLATE.format(city=args.city))
        districts = parse_districts(draw.get("elements", []))
        print(
            f"Parsed {len(districts)} districts: {[d[0] for d in districts]}",
            file=sys.stderr,
        )
    except SystemExit as e:
        print(f"District fetch failed, continuing without hints: {e}", file=sys.stderr)

    places: list[tuple[str, float, float]] = []
    try:
        praw = fetch_overpass(PLACE_QUERY_TEMPLATE.format(city=args.city))
        places = parse_places(praw.get("elements", []))
        print(f"Parsed {len(places)} place nodes", file=sys.stderr)
    except SystemExit as e:
        print(f"Place fetch failed, continuing without area hints: {e}", file=sys.stderr)

    stations: list[tuple[str, float, float]] = []
    try:
        sraw = fetch_overpass(MRT_QUERY_TEMPLATE.format(city=args.city))
        stations = parse_stations(sraw.get("elements", []))
        print(f"Parsed {len(stations)} MRT stations", file=sys.stderr)
    except SystemExit as e:
        print(f"MRT fetch failed, continuing without station hints: {e}", file=sys.stderr)

    features = build_features(raw.get("elements", []), districts, places, stations)

    geojson = {"type": "FeatureCollection", "features": features}
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {args.out}", file=sys.stderr)
    print_stats(features)


if __name__ == "__main__":
    main()
