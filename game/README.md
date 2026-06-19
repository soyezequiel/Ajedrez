# Cliente Vexel — tablero de ajedrez (M1)


Renderiza el tablero y las piezas como **sprites 2D** con el motor
[Vexel](../../vexel) y los conecta al shell web (interop `window.__chess`) y al
servidor (autoridad de reglas).

> **Estado: scaffold, sin compilar.** Faltan `nim` + `emscripten` + `ritual` en la
> máquina. Ver `docs/vexel-integration.md` para el plan y las suposiciones a
> confirmar (`# CONFIRMAR` en `src/ajedrez.nim`).


## Build (cuando esté el toolchain)

Requiere el workspace de vexel (nimby/ritual) + **Emscripten en el PATH** para web.
Ver README de vexel:

```bash
# en el workspace que ya tiene vexel y sus deps:
ritual ajedrez     # desktop: iterar la lógica del tablero
ritual web         # web: WASM + WebGPU → bin/ajedrez.html, sirve en localhost:8080
```

El build web ya está cableado: `config.nims` compila con `emcc`, preload-ea
`shaders/` y `textures/`, exporta `applyFen`/`setInteractive` (ccall) y usa
`shell.html`. Los shaders `sprite-*` (glsl+wgsl) ya están en `shaders/`.


## Cómo se embebe en el shell web (`web/`)

El shell de Vite carga `bin/ajedrez.html` en un **iframe** y se comunican por
`postMessage` (puente definido en `shell.html`):

- Shell → motor: `{ type: "chess:applyFen", fen }`, `{ type: "chess:setInteractive", on }`.
- Motor → shell: `{ type: "chess:move", from, to, promo }`, `{ type: "chess:ready" }`.

Para el swap, reemplazar `web/src/board.ts` (CanvasBoard) por un `VexelBoard` que
cree el iframe y traduzca ese mismo contrato — la red y la UI no cambian.


## Estructura

- `src/ajedrez.nim` — escena Vexel: cámara ortográfica, sprite del tablero,
  sprites de piezas por FEN, input de mouse, interop emscripten.
- `src/chessboard.nim` — lógica pura: parseo de FEN y mapeo casilla↔píxel (sin
  dependencia de vexel).
- `ritual.nim` — tasks de build desktop/web.
- `textures/` — assets (ver abajo).
- `shaders/` — copiar/enlazar `sprite-vertex` y `sprite-fragment` de vexel
  (`.glsl` desktop, `.wgsl` web).


## Assets necesarios (de "claude design", M8)

- `textures/board.png` — tablero 8×8 completo (cuadrado, estilo chess.com).
- `textures/pieces/{wP,wN,wB,wR,wQ,wK,bP,bN,bB,bR,bQ,bK}.png` — una pieza por
  archivo, fondo transparente, cuadradas.
