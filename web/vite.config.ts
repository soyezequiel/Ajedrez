import { defineConfig } from "vite";

// El juego Vexel usa -pthread (SharedArrayBuffer) → la página necesita
// cross-origin isolation (COOP/COEP). Lo aplicamos a dev y preview.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// Build-id inyectado en compilación (lo fija el deploy vía env BUILD_ID). El web lo
// compara contra GET /version para detectar un deploy nuevo y recargar (src/version.ts).
//
// IMPORTANTE: NO va dentro del bundle (define) — eso cambiaría el hash del JS en cada
// deploy y dejaría cualquier index.html viejo (borde/bfcache) apuntando a un bundle
// borrado → 404 → app rota. Va inyectado en el index.html (que se sirve `no-cache`),
// así los bundles hasheados dependen SOLO del código (estables entre redeploys).
const buildId = process.env.BUILD_ID ?? "";

function injectBuildId() {
  return {
    name: "inject-build-id",
    transformIndexHtml() {
      return [
        {
          tag: "script",
          children: `window.__BUILD_ID__=${JSON.stringify(buildId)}`,
          injectTo: "head" as const,
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [injectBuildId()],
  server: {
    port: 5173,
    headers: isolation,
    proxy: { "/api": "http://localhost:8787" },
  },
  preview: { port: 4173, headers: isolation },
  build: { target: "es2022" },
});
