import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves from /<repo>/ — overridable for other hosts.
  base: process.env.BASE_PATH ?? "/",
  build: {
    outDir: "dist",
  },
});
