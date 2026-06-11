import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import {
  addRoadLayers,
  clearAllRoadStates,
  clearRoadState,
  roadsAtPoint,
  setRoadState,
  setTierFilter,
  TIER_POOLS,
  type RoadProps,
  type Tier,
} from "./hittest";
import { Session } from "./game";
import { GameUI } from "./ui";

// Taipei bounds per SPEC §5, with margin for maxBounds.
export const TAIPEI_BOUNDS: [number, number, number, number] = [121.45, 24.96, 121.67, 25.21];
const MARGIN = 0.05;

export function createMap(container: string | HTMLElement): maplibregl.Map {
  return new maplibregl.Map({
    container,
    style: {
      version: 8,
      sources: {
        basemap: {
          type: "raster",
          tiles: ["https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        },
      },
      layers: [{ id: "basemap", type: "raster", source: "basemap" }],
    },
    bounds: TAIPEI_BOUNDS,
    maxBounds: [
      [TAIPEI_BOUNDS[0] - MARGIN, TAIPEI_BOUNDS[1] - MARGIN],
      [TAIPEI_BOUNDS[2] + MARGIN, TAIPEI_BOUNDS[3] + MARGIN],
    ],
  });
}

export async function loadRoads(city = "taipei"): Promise<GeoJSON.FeatureCollection> {
  const res = await fetch(`${import.meta.env.BASE_URL}${city}.geojson`);
  if (!res.ok) throw new Error(`failed to load road data: ${res.status}`);
  return res.json();
}

function setupGame(map: maplibregl.Map, roads: RoadProps[]): void {
  const ui = new GameUI(document.getElementById("ui")!);
  let session: Session | null = null;
  let tier: Tier = "easy";
  let locked = false;

  const counts = Object.fromEntries(
    (Object.keys(TIER_POOLS) as Tier[]).map((t) => {
      const classes = new Set<Tier>(TIER_POOLS[t]);
      return [t, roads.filter((r) => classes.has(r.tier)).length];
    }),
  ) as Record<Tier, number>;

  const showStart = () => {
    ui.hidePrompt();
    clearAllRoadStates(map);
    ui.showStart({ counts, onPick: begin });
  };

  const begin = (t: Tier) => {
    tier = t;
    setTierFilter(map, t);
    session = new Session(roads, t);
    next();
  };

  const next = () => {
    if (!session) return;
    clearAllRoadStates(map);
    const target = session.nextRound();
    if (!target) {
      ui.hidePrompt();
      ui.showSummary({
        score: session.score,
        total: session.totalRounds,
        bestStreak: session.bestStreak,
        onReplay: () => begin(tier),
        onChangeTier: showStart,
      });
      return;
    }
    ui.showPrompt(target.name, session.round, session.totalRounds);
    ui.setScore(session.score, session.streak);
    locked = false;
  };

  map.on("click", (e) => {
    if (locked || !session || !session.target) return;
    const outcome = session.handleTap(roadsAtPoint(map, e.point));
    switch (outcome.kind) {
      case "correct":
        locked = true;
        setRoadState(map, outcome.name, "correct");
        ui.setScore(session.score, session.streak);
        window.setTimeout(next, 1200);
        break;
      case "wrong":
        setRoadState(map, outcome.name, "wrong");
        ui.flashWrong(outcome.name, outcome.missesLeft);
        window.setTimeout(() => clearRoadState(map, outcome.name), 1500);
        break;
      case "reveal":
        locked = true;
        setRoadState(map, outcome.wrongName, "wrong");
        setRoadState(map, outcome.answer, "reveal");
        ui.flashReveal(outcome.answer);
        ui.setScore(session.score, session.streak);
        window.setTimeout(next, 2500);
        break;
    }
  });

  showStart();
}

const map = createMap("map");
// Rotation only disorients on a memorization game — lock to north-up.
map.dragRotate.disable();
map.touchZoomRotate.disableRotation();
map.on("load", async () => {
  const data = await loadRoads();
  addRoadLayers(map, data);
  const roads = data.features.map((f) => f.properties as RoadProps);
  setupGame(map, roads);
});
