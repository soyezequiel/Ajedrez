# Servidor de ajedrez (autoridad)


Servidor autoritativo de ajedrez 1v1. Valida cada jugada con `chess.js`, lleva el
reloj y declara al ganador (el resultado **siempre** lo decide el server, nunca el
cliente). En tiempo real vía **WebSocket**. Además, si existe `web/dist`, **sirve el
build del web** (HTTP + WebSocket en el mismo puerto → deploy unificado de un solo
proceso).


## Correr

```bash
npm install
cp .env.example .env   # opcional (PORT, DEFAULT_CLOCK_MS)
npm run dev            # http://localhost:8787 (solo autoridad; el web va aparte con Vite)
npm start              # sirve web/dist + WS (buildeá el web antes)
npm test               # tests del motor (Vitest)
npm run typecheck
```

Normalmente esto se orquesta desde la raíz del repo (`npm start` / `npm run serve`;
ver el README raíz). El server carga `server/.env` automáticamente (Node ≥20.12, sin
dependencias); las variables ya exportadas en la shell tienen prioridad.

Los headers de aislamiento cross-origin (`COOP`/`COEP`) que necesita el tablero
Vexel (SharedArrayBuffer) los pone este server al servir `web/dist`, igual que Vite
en dev.


## Identidad

Login local por nombre: el cliente manda un nombre en `auth` y el server le asigna
un id estable derivado de ese nombre (`u_<slug>`), útil para reconectar y volver a
la misma sala. No hay cuentas ni tokens externos.


## Piezas

- `src/chessMatch.ts` — autoridad de una partida (legalidad, reloj, mate/abandono/tiempo/tablas). Testeado.
- `src/rooms.ts` — salas en memoria, código de invitación, asignación de colores.
- `src/protocol.ts` — mensajes WebSocket cliente↔servidor (compartible con el cliente web).
- `src/index.ts` — Express (health + estáticos de `web/dist`) + WebSocketServer (orquesta el flujo).


## Flujo WebSocket (resumen)

`auth` → `create_room`/`join_room` → `ready` (ambos) → `match` (jugadas con
`move`, `resign`, `offer_draw`/`accept_draw`) → `ended` (server declara al ganador).

El server también cierra la partida solo: por **timeout** cuando vence el reloj del
jugador en turno, y por **abandono** si un jugador se desconecta y no vuelve dentro
de `ABANDON_GRACE_MS` (avisa con `presence` al rival). Un `join_room` a una sala con
partida re-sincroniza al que entra (snapshot + oferta de tablas + resultado).
