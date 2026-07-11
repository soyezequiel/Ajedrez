# Shell web (chess.com-inspired)


Interfaz del ajedrez: login local por nombre, salas con código/link, reloj y
resultado. Habla con el **servidor** por WebSocket (autoridad de reglas).

El tablero por defecto es el de **Vexel** (WASM/WebGPU): `VexelBoard` carga
`game/bin/ajedrez.js` en la misma página (no iframe — el iframe deadlockea
`requestDevice` con los pthreads de Dawn) y habla por `ccall`/`window.__chess`.
Con `?board=canvas` se usa el `CanvasBoard` interino (PNG de `game/textures/`)
como fallback. Ambos cumplen el contrato `BoardController` (ver `src/board.ts`).

Requisitos del build Vexel: `game/bin` copiado a `public/game/` (`sync-game`) y
COOP/COEP en Vite (`vite.config.ts`). Verificado e2e: una partida (mate del loco)
se renderiza en el tablero de Vexel y propaga el resultado.


## Correr

```bash
# 1) el servidor de ajedrez en otra terminal:
cd ../server && npm install && PORT=8787 npm run dev

# 2) el shell:
npm install
npm run dev        # http://localhost:5173
```

Entrá con un nombre. Para unirse a una sala: `?join=<roomId>` o el código en la home.


## Estructura

- `src/main.ts` — estado, ruteo, pantallas (login, home, partida) y wiring.
- `src/net.ts` — cliente WebSocket tipado.
- `src/board.ts` — tablero canvas interino (swappable por Vexel).
- `src/protocol.ts` — tipos del protocolo (copia de `server/src/protocol.ts`).
- `scripts/sync-assets.mjs` — copia `game/textures/` → `public/textures/`.


## Variables (`.env`)

- `VITE_WS_URL` — WebSocket del servidor (default `ws://localhost:8787`).
