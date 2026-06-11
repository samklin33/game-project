import type { Map as MlMap, MapGeoJSONFeature, PointLike } from "maplibre-gl";

export const SOURCE_ID = "roads";
export const VISIBLE_LAYER = "roads-visible";
export const HIT_LAYER = "roads-hit";

export type Tier = "easy" | "medium" | "hard";

export interface RoadProps {
  name: string;
  tier: Tier;
  length_m: number;
  sections?: string[];
}

/** Cumulative class pools per SPEC §1: picking 中等 includes 簡單 roads. */
export const TIER_POOLS: Record<Tier, Tier[]> = {
  easy: ["easy"],
  medium: ["easy", "medium"],
  hard: ["easy", "medium", "hard"],
};

const HIGHLIGHT_STATES = ["correct", "wrong", "reveal"] as const;
export type HighlightState = (typeof HIGHLIGHT_STATES)[number];

function anyState(): unknown[] {
  // true when the feature carries any highlight state
  return [
    "any",
    ...HIGHLIGHT_STATES.map((s) => ["boolean", ["feature-state", s], false]),
  ];
}

export function addRoadLayers(map: MlMap, data: GeoJSON.FeatureCollection): void {
  // promoteId lets feature-state key on the (unique, post-merge) road name.
  map.addSource(SOURCE_ID, { type: "geojson", data, promoteId: "name" });

  map.addLayer({
    id: VISIBLE_LAYER,
    type: "line",
    source: SOURCE_ID,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": [
        "case",
        ["boolean", ["feature-state", "correct"], false], "#1e8e3e",
        ["boolean", ["feature-state", "wrong"], false], "#d93025",
        ["boolean", ["feature-state", "reveal"], false], "#f9ab00",
        "#94a3b8",
      ] as never,
      "line-width": [
        "interpolate", ["linear"], ["zoom"],
        10, ["case", anyState() as never, 3, 1],
        14, ["case", anyState() as never, 6, 2],
        16, ["case", anyState() as never, 10, 4],
      ] as never,
    },
  });

  // Invisible fat hitbox: same geometry, 22px wide, opacity 0 — taps on a
  // 2px line actually register on mobile (SPEC §4).
  map.addLayer({
    id: HIT_LAYER,
    type: "line",
    source: SOURCE_ID,
    paint: { "line-width": 22, "line-opacity": 0 },
  });
}

/** Show only roads belonging to the chosen difficulty pool. */
export function setTierFilter(map: MlMap, tier: Tier): void {
  const filter = ["in", ["get", "tier"], ["literal", TIER_POOLS[tier]]] as never;
  map.setFilter(VISIBLE_LAYER, filter);
  map.setFilter(HIT_LAYER, filter);
}

/** Resolve a tap to road names; tolerant 8px-bbox retry per SPEC §4. */
export function roadsAtPoint(map: MlMap, point: { x: number; y: number }): string[] {
  let feats = map.queryRenderedFeatures([point.x, point.y] as PointLike, {
    layers: [HIT_LAYER],
  });
  if (feats.length === 0) {
    const r = 8;
    feats = map.queryRenderedFeatures(
      [
        [point.x - r, point.y - r],
        [point.x + r, point.y + r],
      ],
      { layers: [HIT_LAYER] },
    );
  }
  const names = feats.map((f: MapGeoJSONFeature) => (f.properties as RoadProps).name);
  return [...new Set(names)];
}

export function setRoadState(map: MlMap, name: string, state: HighlightState): void {
  map.setFeatureState({ source: SOURCE_ID, id: name }, { [state]: true });
}

export function clearRoadState(map: MlMap, name: string): void {
  map.removeFeatureState({ source: SOURCE_ID, id: name });
}

export function clearAllRoadStates(map: MlMap): void {
  map.removeFeatureState({ source: SOURCE_ID });
}
