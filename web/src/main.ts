import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";
import { addRoadLayers } from "./hittest";

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

const map = createMap("map");
map.on("load", async () => {
  const data = await loadRoads();
  addRoadLayers(map, data);
});
