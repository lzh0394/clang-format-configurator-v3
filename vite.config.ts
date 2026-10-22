import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `VITE_BASE` is injected by CI for GitHub Pages project sites (`/<repo>/`).
// Local dev and the default build stay at `/`.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  worker: { format: "es" },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 600,
  },
});
