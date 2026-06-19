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
backend. El server carga `server/.env` automáticamente (Node ≥20.12, sin
dependencias); las variables ya exportadas en la shell tienen prioridad.


## M0 — pasar de MOCK a LIVE (Luna Negra real)

Para conectarlo al backend real (la API key `ln_sk_…` vive solo acá, nunca en el
cliente):

1. **Crear el juego** en https://luna-negra-three.vercel.app/provider (login
   Nostr como proveedor): nombre, `slug` = `ajedrez`, precio, imágenes y la
   **URL del juego** (la del shell web).
2. Copiar el **`gameId`** → `LUNA_GAME_ID`.
3. Generar una **API key** (`ln_sk_…`) → `LUNA_API_KEY`.
4. (Para apuestas) Registrar el **webhook** a `https://<server-público>/webhook`
   y copiar el secret (`whsec_…`) → `LUNA_WEBHOOK_SECRET`. Opcional para M0: los
   depósitos también se detectan por polling; el webhook solo lo acelera.
5. Pegar todo en `server/.env` (partir de `.env.example`).
6. **Verificar** sin necesitar un jugador real:
   ```bash
   npm run verify:luna
   ```
   Chequea que el deploy responde, que la API key es válida (auth
   server-to-server) y que el webhook secret coincide.
7. `npm run dev` → el log dice `Luna Negra LIVE` y `GET /health` →
   `{ "lunaLive": true }`.

> El SSO real (`?lnToken=…`) solo aparece abriendo el juego **desde** Luna Negra.
> En dev el shell usa tokens `lndemo:<nombre>` que el server resuelve a
> identidades mock; `verify:luna` cubre lo verificable server-side sin token.


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
