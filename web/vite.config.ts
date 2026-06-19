import { defineConfig } from "vite";

// El juego Vexel usa -pthread (SharedArrayBuffer) → la página necesita
// cross-origin isolation (COOP/COEP). Lo aplicamos a dev y preview.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  server: { port: 5173, headers: isolation },
  preview: { port: 4173, headers: isolation },
  build: { target: "es2022" },
});
