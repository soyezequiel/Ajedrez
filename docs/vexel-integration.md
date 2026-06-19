# M1 — Cliente de ajedrez en Vexel (tablero 2D + interop web)


Plan concreto para renderizar el ajedrez con **Vexel** (branch `dev`,
`F:\proyectos\vexel`) y conectarlo al shell web y al servidor. Basado en la API
real de los samples (`src/sample/intro.nim`, `web/web.nim`, `input.nim`).

> Estado: **scaffold escrito, sin compilar todavía** — en esta máquina faltan
> `nim`, `emscripten` y `ritual`. Verificar/iterar cuando estén instalados.


## Render del tablero (screen-space, sprites 2D)

Vexel ya trae todo lo necesario para 2D:

- Cámara: `orthographicCamera()` montada con `makeBoundCamera(windowId, …)`
  (igual que `spriteCamera` en `web.nim`).
- Shaders reutilizables: `shaders/sprite-vertex` + `shaders/sprite-fragment`
  (`.glsl` en desktop, `.wgsl` en web — ver `shaderExt` en `intro.nim`).
- Sprite: `makeSprite(renders(spriteRasterizer), name, transform(position, rotation, scale))`.
  En el sample el legend usa `position = vec3(100,0,0)`, `scale = vec3(360,85,1)`
  → las unidades de la cámara ortográfica son **píxeles**, origen en el centro.

**Estrategia de assets (de "claude design"):**
- `textures/board.png` — un único sprite con el tablero 8×8 completo (estilo chess.com).
- `textures/pieces/{wP,wN,wB,wR,wQ,wK,bP,…}.png` — un sprite por tipo de pieza
  (o un atlas; arrancamos con archivos sueltos por simplicidad).

**Layout:** ventana 960×540. Tablero cuadrado de lado `BOARD = 512` centrado.
Casilla `CELL = BOARD/8 = 64`. La esquina sup-izq del tablero en coords de la
cámara (centro = origen, +y hacia arriba) es `(-BOARD/2, +BOARD/2)`. Para una
casilla `(file 0..7, rank 0..7)` con blancas abajo:

```
x = -BOARD/2 + CELL/2 + file*CELL
y =  BOARD/2 - CELL/2 - rank*CELL   # rank 0 = fila 8 arriba
```

Cada pieza es un sprite posicionado en el centro de su casilla; mover = actualizar
`transform.position` (igual que el cubo gira en el loop del sample con
`world.write(id of Transform)`).


## Input → casilla

Usar el `MouseController` incorporado (`src/inputs/entities.nim`):

```nim
var controllers = makeControllers(MouseController)
let mouseId = world.add((MouseController(),), Immediate) of MouseController
# en el frame:
let mouse = world.read(mouseId)
if mouse.left.justPressed:
  let p = mouse.pointer.position      # Vec2 en px de ventana (origen sup-izq)
  let sq = pixelToSquare(p)           # → "e2" o none si cae fuera del tablero
```

`pixelToSquare` invierte el layout de arriba (ojo: `pointer.position` viene en
coords de **ventana** con origen arriba-izquierda; la cámara ortográfica tiene
origen al centro con +y arriba → hay que convertir).

Interacción: primer clic selecciona pieza propia (pedir `legalMovesFrom` al server
o resaltar localmente), segundo clic intenta la jugada. La **autoridad es el
server**: el cliente manda `{from,to}` y solo re-renderiza cuando llega el `match`
con el FEN nuevo.


## Interop JS ↔ WASM (web)

El shell web (TS, M2) maneja login/lobby/amigos/apuesta/top en DOM y la conexión
WebSocket al server. El canvas Vexel solo dibuja el tablero y emite intentos de
jugada. Contrato mínimo:

**JS → Nim (aplicar estado):** exportar funciones desde Nim con `{.exportc.}` y
compilar emscripten con `-sEXPORTED_FUNCTIONS=_applyFen,_setInteractive,_highlight`
y `-sEXPORTED_RUNTIME_METHODS=ccall,cwrap`. El shell llama:

```js
Module.ccall("applyFen", null, ["string"], [fen]);
Module.ccall("setInteractive", null, ["number"], [myTurn ? 1 : 0]);
```

```nim
proc applyFen(fen: cstring) {.exportc.} = pendingFen = $fen   # el loop lo aplica
proc setInteractive(on: cint) {.exportc.} = interactive = on != 0
```

**Nim → JS (emitir jugada):** desde Nim invocar una función JS global con `EM_JS`
o `emscripten_run_script`:

```nim
proc emitMove(fromSq, toSq, promo: cstring) =
  when defined(emscripten):
    discard EM_ASM_INT("window.__chess.onMove(UTF8ToString($0),UTF8ToString($1),UTF8ToString($2))",
                       fromSq, toSq, promo)
```

```js
window.__chess = { onMove: (from, to, promo) => ws.send(JSON.stringify({ t:"move", move:{from,to,promotion:promo||undefined} })) };
```

> En desktop (dev del juego) el interop se reemplaza por stdin/teclado o un mock;
> la lógica de tablero es la misma, solo cambia el transporte.


## Build

- Desktop (iterar rápido la lógica): `ritual ajedrez` (task nuevo, espejo de `intro`).
- Web (target real): `ritual web-ajedrez` → `nim c --path:<vexel> -d:emscripten`
  con el shell propio (`--passL:--shell-file=web/shell.html` apuntando a nuestro
  HTML que define `window.__chess` y carga el bundle del shell TS, o cargando el
  `.js`/`.wasm` desde el shell de Vite en M2).

El proyecto `game/` consume `vexel` como dependencia (workspace `nimby`/`ritual`,
ver README de vexel). `ajedrez.nimble` declara `requires "vexel"`.


## Checklist M1
- [ ] `game/` compila en desktop y dibuja `board.png` centrado.
- [ ] Piezas se ubican por FEN (posición inicial) y se mueven al recibir FEN nuevo.
- [ ] Clic mapea a casilla correcta; selección + intento de jugada.
- [ ] Build web (emscripten) corre en el navegador con el canvas.
- [ ] `applyFen`/`setInteractive`/`highlight` exportadas; `onMove` llega al shell.
- [ ] Resalte de casillas legales y de la última jugada.
