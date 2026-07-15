# Ajedrez online (motor Vexel)


Ajedrez 1v1 inspirado en chess.com: el servidor es la autoridad (valida jugadas,
lleva el reloj, declara al ganador) y el tablero se renderiza con el motor
**Vexel**.


## Piezas del repo

| Carpeta | Qué es | Estado |
|---|---|---|
| `server/` | Servidor autoritativo (chess.js + WebSocket) | OK — funcionando, 10 tests |
| `web/` | Shell TS estilo chess.com (login por nombre, lobby, partida) | OK — tablero interino canvas, verificado e2e |
| `game/` | Cliente Vexel: tablero 2D (sprites) + interop web | scaffold + assets; falta compilar (nim/emscripten) |
| `docs/` | Plan de integración Vexel y specs | — |


## Arquitectura

```
  server/  (autoridad)              web/ (+ game/ Vexel)
  reglas chess.js · salas · WS  <--> shell TS + tablero
  sirve web/dist + WebSocket         (canvas hoy, Vexel luego)
  en el mismo puerto
```

El **resultado siempre lo decide el servidor**: el cliente solo renderiza y
propone jugadas. En el deploy, el `server/` **sirve también el build del `web/`**
(HTTP + WebSocket en el mismo puerto), así que corre como **un solo proceso**. Ver
`docs/vexel-integration.md`, `server/README.md` y `web/README.md`.


## Correr

Primera vez, instalar dependencias de ambos:

```bash
npm run install:all
```

**Jugar (deploy unificado, un solo proceso):**

```bash
npm start        # buildea el web y levanta el server en http://localhost:8787
```

Abrí **http://localhost:8787**: entrás con un nombre, "Crear sala" y le pasás el
link o el código al rival. En una red local, otros pueden entrar desde
`http://TU-IP-LOCAL:8787` (el link de invitación usa esa IP automáticamente).
`npm run serve` levanta el server sin rebuildear el web (si ya lo buildeaste).

**Desarrollar (dos procesos, con hot-reload del web):**

```bash
npm run dev:server     # autoridad en :8787
npm run dev:web        # shell Vite en :5173 (otra terminal)
```

Verificado end-to-end: login por nombre → crear sala → 2 jugadores → partida
relayada por el servidor → resultado y banner de ganador.


## Kit de login BAL reutilizable

La integración de Bunker Auto Login no está acoplada a Ajedrez. Vive en el
paquete `nostr-bal-browser-sdk` del repositorio hermano `herramientas nostr` y
Ajedrez lo consume como una dependencia local durante el desarrollo.

El README del SDK explica cómo instalarlo desde GitHub, configurar permisos y
conectar el signer al challenge de autenticación propio de otro juego.

`web/src/nostr/bal-login.ts` es únicamente el adaptador de Ajedrez y sirve como
ejemplo mínimo de configuración.


## Prerequisitos pendientes

- **Instalar `nim` + `emscripten` + `ritual`** para compilar el cliente Vexel (M1)
  y reemplazar el tablero canvas por el de Vexel (mismo contrato `window.__chess`).
