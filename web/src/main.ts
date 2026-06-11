import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import {
  addRoadLayers,
  clearAllRoadStates,
  clearRoadState,
  distanceToFeaturesM,
  featuresBounds,
  roadsAtPoint,
  setRoadState,
  setVisibilityFilter,
  type RoadProps,
} from "./hittest";
import { buildPools, Session, type Difficulty, type TapOutcome } from "./game";
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
      layers: [
        // Positron-toned backdrop so missing/loading tiles aren't a void
        { id: "bg", type: "background", paint: { "background-color": "#f7f7f5" } },
        { id: "basemap", type: "raster", source: "basemap" },
      ],
    },
    bounds: TAIPEI_BOUNDS,
    maxBounds: [
      [TAIPEI_BOUNDS[0] - MARGIN, TAIPEI_BOUNDS[1] - MARGIN],
      [TAIPEI_BOUNDS[2] + MARGIN, TAIPEI_BOUNDS[3] + MARGIN],
    ],
  });
}

export async function loadRoads(city = "taipei"): Promise<GeoJSON.FeatureCollection> {
  const res = await fetch(
    `${import.meta.env.BASE_URL}${city}.geojson?v=${__DATA_VERSION__}`,
  );
  if (!res.ok) throw new Error(`failed to load road data: ${res.status}`);
  return res.json();
}

function setupGame(map: maplibregl.Map, data: GeoJSON.FeatureCollection): void {
  const ui = new GameUI(document.getElementById("ui")!);
  const featuresByName = new Map<string, GeoJSON.Feature>();
  const baseToNames = new Map<string, string[]>();
  for (const f of data.features) {
    const p = f.properties as RoadProps;
    featuresByName.set(p.name, f);
    const siblings = baseToNames.get(p.base);
    if (siblings) siblings.push(p.name);
    else baseToNames.set(p.base, [p.name]);
  }
  const pools = buildPools(data.features.map((f) => f.properties as RoadProps));
  const counts = Object.fromEntries(
    Object.entries(pools).map(([d, pool]) => [d, pool.length]),
  ) as Record<Difficulty, number>;

  let session: Session | null = null;
  let difficulty: Difficulty = "easy";
  let locked = false;
  const easyBases = pools.easy.map((p) => p.label);

  const targetFeatures = (p: { targets: string[] }) =>
    p.targets.map((n) => featuresByName.get(n)).filter((f): f is GeoJSON.Feature => !!f);

  const showStart = () => {
    session = null;
    ui.hidePrompt();
    clearAllRoadStates(map);
    setVisibilityFilter(map, "all", easyBases);
    ui.showStart({ counts, onPick: begin });
  };

  const begin = (d: Difficulty) => {
    difficulty = d;
    setVisibilityFilter(map, d, easyBases);
    session = new Session(pools[d]);
    next();
  };

  const next = () => {
    if (!session) return;
    clearAllRoadStates(map);
    const target = session.nextRound();
    if (!target) {
      ui.hidePrompt();
      ui.showSummary({
        points: session.points,
        maxPoints: session.maxPoints,
        correct: session.correctCount,
        total: session.totalRounds,
        bestStreak: session.bestStreak,
        onReplay: () => begin(difficulty),
        onChangeTier: showStart,
      });
      return;
    }
    ui.showPrompt(target.label, session.round, session.totalRounds);
    ui.setScore(session.points, session.streak);
    locked = false;
  };

  const handleReveal = (outcome: Extract<TapOutcome, { kind: "reveal" }>) => {
    locked = true;
    for (const name of outcome.targets) setRoadState(map, name, "reveal");
    map.fitBounds(featuresBounds(targetFeatures(outcome)), {
      padding: 80,
      maxZoom: 15,
      duration: 900,
    });
    ui.flashReveal(outcome.label);
    ui.setScore(session!.points, session!.streak);
    window.setTimeout(next, 3000);
  };

  map.on("click", (e) => {
    if (locked || !session || !session.target) return;
    const target = session.target;
    const outcome = session.handleTap(roadsAtPoint(map, e.point));
    switch (outcome.kind) {
      case "correct":
        locked = true;
        for (const name of outcome.targets) setRoadState(map, name, "correct");
        ui.setScore(session.points, session.streak);
        window.setTimeout(next, 1200);
        break;
      case "wrong": {
        // 簡單/中等 quiz whole roads, so name and flash the whole road —
        // being told 「這是忠孝東路四段」 when sections aren't in play
        // is confusing.
        const grouped = difficulty === "easy" || difficulty === "medium";
        const base = (featuresByName.get(outcome.name)?.properties as RoadProps | undefined)?.base;
        const label = grouped && base ? base : outcome.name;
        const flash = grouped && base ? (baseToNames.get(base) ?? [outcome.name]) : [outcome.name];
        for (const n of flash) setRoadState(map, n, "wrong");
        const dist = distanceToFeaturesM(targetFeatures(target), e.lngLat);
        ui.flashWrong(label, outcome.attemptsLeft, dist);
        window.setTimeout(() => {
          for (const n of flash) clearRoadState(map, n);
        }, 1800);
        break;
      }
      case "reveal":
        handleReveal(outcome);
        break;
    }
  });

  ui.onGiveUp = () => {
    if (locked || !session || !session.target) return;
    const outcome = session.reveal();
    if (outcome.kind === "reveal") handleReveal(outcome);
  };
  ui.onQuit = showStart;

  showStart();
}

const map = createMap("map");
// Rotation only disorients on a memorization game — lock to north-up.
map.dragRotate.disable();
map.touchZoomRotate.disableRotation();
// e2e handle
(window as unknown as { __map: maplibregl.Map }).__map = map;
map.on("load", async () => {
  const data = await loadRoads();
  addRoadLayers(map, data);
  setupGame(map, data);
});
