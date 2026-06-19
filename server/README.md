# Servidor de ajedrez (autoridad)


Servidor autoritativo de ajedrez con apuestas en sats sobre **Luna Negra**.
Valida cada jugada con `chess.js`, lleva el reloj, declara el ganador y reporta
el resultado a Luna Negra (el dinero **siempre** lo decide el server, nunca el
cliente). En tiempo real vía **WebSocket**; integración con Luna Negra vía REST.


## Correr

```bash
npm install
cp .env.example .env   # opcional; sin credenciales corre en modo MOCK
npm run dev            # http://localhost:8787
npm test               # tests del motor (Vitest)
npm run typecheck
```

Sin `LUNA_API_KEY`/`LUNA_GAME_ID` el cliente de Luna Negra cae en **modo mock**
(identidad `lndemo:<nombre>`, apuesta fondeada al instante) para desarrollar sin
backend.


## Piezas

- `src/chessMatch.ts` — autoridad de una partida (legalidad, reloj, mate/abandono/tiempo/tablas). Testeado.
- `src/rooms.ts` — salas en memoria, código de invitación, asignación de colores.
- `src/lunaNegra.ts` — cliente server-to-server de Luna Negra (§1 sesión, §3 presencia, §5 amigos/invites, §7 apuestas, §8 webhook) + fallback mock.
- `src/protocol.ts` — mensajes WebSocket cliente↔servidor (compartible con el cliente web).
- `src/index.ts` — Express (health + webhook) + WebSocketServer (orquesta el flujo).


## Flujo WebSocket (resumen)

`auth` → `create_room`/`join_room` → `ready` (ambos) → [si hay apuesta: `bet` +
espera de depósitos] → `match` (jugadas con `move`, `resign`, `offer_draw`/
`accept_draw`) → `ended` (server reporta ganador a Luna Negra).
