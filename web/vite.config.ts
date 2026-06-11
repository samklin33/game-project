import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves from /<repo>/ — overridable for other hosts.
  base: process.env.BASE_PATH ?? "/",
  // Serve the committed road data at the site root (dev and build alike),
  // so future cities are just more files in data/.
  publicDir: "../data",
  // Data files keep a stable URL, so bust HTTP caches per deploy —
  // stale geojson under new JS breaks the prompt pools.
  define: {
    __DATA_VERSION__: JSON.stringify(
      process.env.GITHUB_SHA?.slice(0, 12) ?? Date.now().toString(36),
    ),
  },
  build: {
    outDir: "dist",
  },
});
