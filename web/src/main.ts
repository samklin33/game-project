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

function startGame(map: maplibregl.Map, roads: RoadProps[], tier: Tier): void {
  setTierFilter(map, tier);
  const ui = new GameUI(document.getElementById("ui")!);
  let session = new Session(roads, tier);
  let locked = false;

  const next = () => {
    clearAllRoadStates(map);
    const target = session.nextRound();
    if (!target) {
      ui.hidePrompt();
      ui.showSummary({
        score: session.score,
        total: session.totalRounds,
        bestStreak: session.bestStreak,
        onReplay: () => {
          session = new Session(roads, tier);
          next();
        },
      });
      return;
    }
    ui.showPrompt(target.name, session.round, session.totalRounds);
    ui.setScore(session.score, session.streak);
    locked = false;
  };

  map.on("click", (e) => {
    if (locked || !session.target) return;
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

  next();
}

const map = createMap("map");
map.on("load", async () => {
  const data = await loadRoads();
  addRoadLayers(map, data);
  const roads = data.features.map((f) => f.properties as RoadProps);
  startGame(map, roads, "medium");
});
