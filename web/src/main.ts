import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import {
  addRoadLayers,
  clearAllRoadStates,
  clearRoadState,
  distanceToFeaturesM,
  featuresBounds,
  hasRoadSource,
  roadsAtPoint,
  setRoadData,
  setRoadState,
  setVisibilityFilter,
  type RoadProps,
} from "./hittest";
import {
  buildPools,
  Session,
  type Difficulty,
  type Prompt,
  type SessionOptions,
  type TapOutcome,
} from "./game";
import { GameUI, type City } from "./ui";

const MARGIN = 0.05; // maxBounds padding around a city, in degrees

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
        { id: "bg", type: "background", paint: { "background-color": "#f7f7f5" } },
        { id: "basemap", type: "raster", source: "basemap" },
      ],
    },
    center: [121.0, 23.7], // Taiwan-wide until a city is chosen
    zoom: 6.5,
  });
}

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${import.meta.env.BASE_URL}${path}?v=${__DATA_VERSION__}`);
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status}`);
  return res.json();
}

export const loadCities = () => fetchJSON<City[]>("cities.json");
export const loadRoads = (file: string) => fetchJSON<GeoJSON.FeatureCollection>(file);

function setupGame(map: maplibregl.Map, cities: City[]): void {
  const ui = new GameUI(document.getElementById("ui")!);
  const CITY_KEY = "zhaolu-city";
  const OPTS_KEY = "zhaolu-session-opts";

  // Per-city state, rebuilt on every city switch.
  let featuresByName = new Map<string, GeoJSON.Feature>();
  let baseToNames = new Map<string, string[]>();
  let pools: Record<Difficulty, Prompt[]> = { easy: [], medium: [], hard: [], extreme: [] };
  let counts = { easy: 0, medium: 0, hard: 0, extreme: 0 } as Record<Difficulty, number>;
  let poolBases = { easy: [] as string[], medium: [] as string[] };
  let city: City = cities[0];

  let session: Session | null = null;
  let difficulty: Difficulty = "easy";
  let locked = false;

  let sessionOpts: SessionOptions = { rounds: 10, maxAttempts: 3 };
  try {
    const saved = JSON.parse(localStorage.getItem(OPTS_KEY) ?? "");
    if (typeof saved.rounds === "number") sessionOpts.rounds = saved.rounds;
    sessionOpts.maxAttempts = saved.maxAttempts === null ? Infinity : saved.maxAttempts;
  } catch {
    /* first visit */
  }
  const saveOpts = () =>
    localStorage.setItem(
      OPTS_KEY,
      JSON.stringify({
        rounds: sessionOpts.rounds,
        maxAttempts: Number.isFinite(sessionOpts.maxAttempts) ? sessionOpts.maxAttempts : null,
      }),
    );

  const targetFeatures = (p: { targets: string[] }) =>
    p.targets.map((n) => featuresByName.get(n)).filter((f): f is GeoJSON.Feature => !!f);

  async function loadCity(c: City): Promise<void> {
    const data = await loadRoads(c.file);
    city = c;
    localStorage.setItem(CITY_KEY, c.id);
    if (hasRoadSource(map)) setRoadData(map, data);
    else addRoadLayers(map, data);

    featuresByName = new Map();
    baseToNames = new Map();
    for (const f of data.features) {
      const p = f.properties as RoadProps;
      featuresByName.set(p.name, f);
      const sib = baseToNames.get(p.base);
      if (sib) sib.push(p.name);
      else baseToNames.set(p.base, [p.name]);
    }
    pools = buildPools(data.features.map((f) => f.properties as RoadProps));
    counts = Object.fromEntries(
      Object.entries(pools).map(([d, pool]) => [d, pool.length]),
    ) as Record<Difficulty, number>;
    poolBases = { easy: pools.easy.map((p) => p.label), medium: pools.medium.map((p) => p.label) };

    // Lock the view to this city's extent.
    const b = featuresBounds(data.features);
    map.setMaxBounds(null);
    map.fitBounds(b, { padding: 20, duration: 0 });
    map.setMaxBounds([
      [b[0][0] - MARGIN, b[0][1] - MARGIN],
      [b[1][0] + MARGIN, b[1][1] + MARGIN],
    ]);
  }

  const showCitySelect = () => {
    session = null;
    ui.hidePrompt();
    ui.showCitySelect({
      cities,
      current: city.id,
      onPick: async (c) => {
        ui.showLoading(`載入${c.name}…`);
        await loadCity(c);
        showStart();
      },
    });
  };

  const showStart = () => {
    session = null;
    ui.hidePrompt();
    clearAllRoadStates(map);
    setVisibilityFilter(map, "all", poolBases);
    ui.showStart({
      cityName: city.name,
      counts,
      defaults: sessionOpts,
      onPick: (d, chosen) => {
        sessionOpts = chosen;
        saveOpts();
        begin(d);
      },
      onChangeCity: showCitySelect,
    });
  };

  const begin = (d: Difficulty) => {
    difficulty = d;
    setVisibilityFilter(map, d, poolBases);
    session = new Session(pools[d], sessionOpts);
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
        difficulty,
        onReplay: () => begin(difficulty),
        onChangeTier: showStart,
      });
      return;
    }
    ui.showPrompt(target.label, session.round, session.totalRounds, !!target.hint);
    ui.setScore(session.points, session.streak);
    locked = false;
  };

  const handleReveal = (outcome: Extract<TapOutcome, { kind: "reveal" }>) => {
    locked = true;
    for (const name of outcome.targets) setRoadState(map, name, "reveal");
    map.fitBounds(featuresBounds(targetFeatures(outcome)), { padding: 80, maxZoom: 15, duration: 900 });
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
  ui.onHint = () => {
    if (locked || !session || !session.target) return;
    const hint = session.useHint();
    if (hint) ui.showHint(hint);
  };
  ui.onQuit = showStart;

  // Boot: restore last city if still available, else show the picker.
  const lastId = localStorage.getItem(CITY_KEY);
  const last = cities.find((c) => c.id === lastId);
  if (last) {
    ui.showLoading(`載入${last.name}…`);
    loadCity(last).then(showStart);
  } else {
    showCitySelect();
  }
}

const map = createMap("map");
map.dragRotate.disable();
map.touchZoomRotate.disableRotation();
(window as unknown as { __map: maplibregl.Map }).__map = map;
map.on("load", async () => {
  const cities = await loadCities();
  setupGame(map, cities);
});
