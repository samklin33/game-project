# 找路 (zhao-lu) — Reverse Taiwan Road Memorization Game

> The original game: type a road name → it lights up on the map.
> **This game: the map shows you a road name → you tap where it is.**

## 1. Game definition

- Player picks a city (v1: 臺北市 only; homepage city selector is a v2 goal — architect for it now).
- Each round, the game shows one road name (e.g. 「羅斯福路」).
- Player taps anywhere on the map. Hit-test resolves which road was tapped.
  - **Correct** → entire road lights up green (all segments), score +1, streak +1.
  - **Wrong** → tapped road flashes red with its real name shown for 1.5 s;
    after 3 misses, reveal the answer road in amber, streak resets.
- Basemap must be **label-free** (labels = cheating).
- Round ends → next random road. Session = 10 rounds, summary screen at the end.

### Difficulty tiers (by OSM `highway` class)
| Tier | Classes | Roughly |
|------|---------|---------|
| 簡單 | trunk, primary | 忠孝東路-level arterials |
| 中等 | + secondary, tertiary | district-level roads |
| 困難 | + residential, unclassified | 巷弄 hell |

## 2. Architecture

```
repo/
├── SPEC.md                  ← this file
├── scripts/
│   └── build_roads.py       ← Overpass → merged GeoJSON
├── data/
│   └── taipei.geojson       ← build output (committed, ~city-sized OK)
├── web/
│   ├── index.html
│   ├── src/
│   │   ├── main.ts          ← app bootstrap, MapLibre init
│   │   ├── game.ts          ← round state machine, scoring
│   │   ├── hittest.ts       ← tap → road resolution
│   │   └── ui.ts            ← prompt card, score, summary
│   └── vite.config.ts
└── .github/workflows/
    └── deploy.yml           ← build + GitHub Pages
```

Stack: **Vite + TypeScript + MapLibre GL JS**. No backend — static site, GeoJSON loaded client-side.

## 3. Data pipeline (`scripts/build_roads.py`)

1. Query Overpass for named roads inside the city boundary:
   ```
   [out:json][timeout:180];
   area["name"="臺北市"]["admin_level"="4"]->.city;
   way(area.city)["highway"~"^(trunk|primary|secondary|tertiary|residential|unclassified)$"]["name"];
   out geom;
   ```
2. **Merge by name**: one road = many OSM ways. Group ways by `name` tag →
   one feature per road with `MultiLineString` geometry.
   - Normalize names: strip whitespace, unify full/half-width, keep 一段/二段
     suffixes merged into the parent road (「忠孝東路一段」…「七段」→「忠孝東路」,
     store sections in `properties.sections` for a future hint feature).
   - Keep `properties`: `name`, `tier`, `length_m` (sum of segment lengths).
3. Drop roads shorter than 150 m in 簡單/中等 tiers (untappable specks).
4. Output `data/taipei.geojson`. Print stats (road count per tier) for the commit message.
5. Design the script as `build_roads.py --city 臺北市 --out data/taipei.geojson` so adding cities later is a CLI call, not a code change.

Caveat to handle: duplicate names across districts (rare in Taipei proper, common elsewhere).
If duplicates exist after merging, accept **any** of them as a correct tap.

## 4. Hit-testing (`hittest.ts`)

- Render two layers from the same source:
  - `roads-visible`: thin line, neutral color.
  - `roads-hit`: same geometry, `line-width: 22`, `line-opacity: 0` — the invisible fat hitbox.
- On tap: `map.queryRenderedFeatures(point, { layers: ['roads-hit'] })`.
  - Empty result → tolerant retry with an 8 px bbox around the point.
  - Multiple results (intersections) → if **any** matches the prompt, count as correct
    (player tapped the road, the overlap isn't their fault).
- Light-up = `setFeatureState` on all features sharing the road name (style with
  `feature-state` driven `line-color`).

## 5. Basemap

CartoDB Positron **no-labels** raster tiles:
`https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png` (attribution required).
Start view: Taipei bounds `[121.45, 24.96, 121.67, 25.21]`, maxBounds locked to city + margin.

## 6. Milestones → commit plan (Conventional Commits)

1. `chore: scaffold vite + maplibre project, add SPEC`
2. `feat(data): overpass fetch + merge-by-name pipeline for Taipei`
3. `feat(map): render label-free basemap with road layers`
4. `feat(game): round loop — prompt, tap, hit-test, light-up`
5. `feat(game): scoring, streaks, 3-miss reveal, session summary`
6. `feat(ui): difficulty tiers + polish (mobile tap targets!)`
7. `ci: deploy to GitHub Pages`
8. `exp:` commits for any hit-tolerance / tier-threshold tuning runs

Each milestone = one PR-sized commit, so the GitHub history reads as the build log.

## 7. v2 backlog (do NOT build now)

- City selector homepage (data pipeline already parameterized)
- Section-level hints (「它在一段…」)
- Timed mode / leaderboard
- 巷弄 expert mode with zoom-locked viewport
