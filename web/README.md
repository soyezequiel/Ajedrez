# Shell web (chess.com-inspired)


Interfaz del ajedrez: login SSO de Luna Negra (§1), salas con código/link,
barra de amigos, panel de apuesta, reloj y resultado. Habla con el **servidor**
por WebSocket (autoridad de reglas) y se conecta a **Luna Negra** para identidad
y top.

El tablero hoy es un **canvas interino** (`src/board.ts`) que usa los PNG de
`game/textures/`. Implementa el contrato `applyFen` / `setInteractive` /
`highlight` y emite jugadas por `window.__chess.onMove(...)` — **el mismo
contrato** que usará el canvas de Vexel (M1), así el swap es directo.


## Correr

```bash
# 1) el servidor de ajedrez en otra terminal:
cd ../server && npm install && PORT=8787 npm run dev

# 2) el shell:
npm install
npm run dev        # http://localhost:5173
```

Modo dev sin Luna Negra: entrá con un nombre, o abrí
`http://localhost:5173/?lnDemo=Ana`. En producción Luna Negra abre el juego con
`?lnToken=`. Para unirse a una sala: `?join=<roomId>` o el código en la home.

Verificado end-to-end (mock): SSO → crear sala con apuesta → 2 jugadores →
partida relayada por el server → resultado y banner de ganador.


## Estructura

- `src/main.ts` — estado, ruteo, pantallas (login, home, partida) y wiring.
- `src/net.ts` — cliente WebSocket tipado.
- `src/board.ts` — tablero canvas interino (swappable por Vexel).
- `src/protocol.ts` — tipos del protocolo (copia de `server/src/protocol.ts`).
- `scripts/sync-assets.mjs` — copia `game/textures/` → `public/textures/`.


## Variables (`.env`)

- `VITE_WS_URL` — WebSocket del servidor (default `ws://localhost:8787`).
- `VITE_LUNA_URL` — base de Luna Negra (para el top).
