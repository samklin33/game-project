import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves from /<repo>/ — overridable for other hosts.
  base: process.env.BASE_PATH ?? "/",
  // Serve the committed road data at the site root (dev and build alike),
  // so future cities are just more files in data/.
  publicDir: "../data",
  build: {
    outDir: "dist",
  },
});
