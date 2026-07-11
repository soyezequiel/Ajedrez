## Cliente de ajedrez (tablero 2D) sobre Vexel.
##
## ⚠️  SCAFFOLD SIN COMPILAR — escrito contra la API de los samples de vexel
## (`src/sample/web/web.nim`, `input.nim`). Faltan nim/emscripten en la máquina;
## verificar firmas y ajustar al primer build. Las suposiciones a confirmar van
## marcadas con `# CONFIRMAR`.
##
## Arquitectura: el shell web (TS) maneja login/lobby y la conexión
## WebSocket; este canvas solo dibuja el tablero y emite intentos de jugada. La
## autoridad de las reglas es el servidor (ver docs/vexel-integration.md).

import vexel
import chessboard
import std/[options, strutils, tables]


type
  Input = object
    position: Vec3
    uv: Vec2
    color: Vec4

  Interface = object
    color: Vec4
    uv: Vec2

  Output = object
    color: Vec4


proc shaderExt(shader: string): string =
  shader & (when defined(emscripten): ".wgsl" else: ".glsl")


const
  WinW = 600          ## canvas cuadrado para embeber prolijo en el shell
  WinH = 600
  Board = 560.0'f32   ## lado del tablero en px (margen chico dentro del canvas)


# --- Estado compartido con el interop (JS → Nim) --------------------------

var
  pendingFen = StartFen   ## último FEN recibido; el loop lo aplica
  interactive = false     ## ¿es mi turno? (habilita clics)
  selected = none(tuple[file, rank: int])
  flipped = false         ## true = juego con negras (tablero dado vuelta)
  lastMove: seq[tuple[file, rank: int]] = @[]  ## casillas de la última jugada
  boardDirty = true       ## reposicionar sprites en el próximo frame
  occupancy: Table[tuple[file, rank: int], PieceCode]  ## piezas del FEN aplicado


# JS → Nim: el shell llama Module.ccall("applyFen"/"setInteractive"/…, …)
proc applyFen(fen: cstring) {.exportc.} =
  pendingFen = $fen

proc setInteractive(on: cint) {.exportc.} =
  let v = on != 0
  if v != interactive:
    interactive = v
    if not v: selected = none(tuple[file, rank: int])
    boardDirty = true

proc setOrientation(black: cint) {.exportc.} =
  let f = black != 0
  if f != flipped:
    flipped = f
    boardDirty = true

# Casillas de la última jugada separadas por espacio ("e2 e4"); "" limpia.
proc highlight(squares: cstring) {.exportc.} =
  var next: seq[tuple[file, rank: int]] = @[]
  for tok in ($squares).split(' '):
    let sq = parseSquare(tok)
    if sq.isSome: next.add sq.get
  if next != lastMove:
    lastMove = next
    boardDirty = true


when defined(emscripten):
  proc emscripten_run_script(script: cstring) {.importc, header: "<emscripten.h>".}

# Nim → JS: emite un intento de jugada al shell (que lo manda por WebSocket).
# Las casillas son algebraicas simples ("e2"), sin comillas → embeber es seguro.
proc emitMove(fromSq, toSq: string) =
  when defined(emscripten):
    emscripten_run_script(("window.__chess.onMove('" & fromSq & "','" & toSq & "','');").cstring)
  else:
    echo "move ", fromSq, " -> ", toSq   # dev desktop


# --- Setup de escena ------------------------------------------------------

var windows = windowManager()
let time = startTime()
var scene = scene()
var world = World()
var graphics = startWgpuGraphics(windows)

# En web el input lo maneja JS (clics del canvas → clickAt), no el sistema de
# input de Vexel: su módulo de gamepad referencia glfwGetGamepadState, que la
# GLFW de emscripten no provee (undefined symbol al linkear).

let window = makeWindow("Ajedrez", uvec2(WinW, WinH), false, true, main = true)
let windowId = world.add(window, Immediate) of Window

let depth = world.makeWindowTexture(windowId, { TextureUsage.AttachTexture }, true)
let depthId = world.add(depth) of Texture

let spriteCamera = makeBoundCamera(
  windowId,
  name = "sprite camera",
  camera = orthographicCamera(),
  transform = transform(vec3(0, 0, 0.1), vec3(0, 0, 0).anglesToQuat),
)
let spriteCameraId = world.add(spriteCamera, Immediate) of Camera

let rootId = world.add(makeRoot(), Immediate) of Node
world.setParentOf(spriteCameraId of Node, rootId)


## Un rasterizer de sprite por textura (patrón probado del sample: una textura
## por binding). Las piezas usan 12 texturas (wP…bK). CONFIRMAR: si conviene un
## atlas único con offsets de uv para reducir draw calls.
proc spriteRasterizer(texturePath: string): Id[Rasterizer] =
  let texture = world.add(loadTexture(texturePath)) of Texture
  world.add(rasterizer(
    shader[Input, Interface]("shaders/sprite-vertex".shaderExt),
    shader[Interface, Output]("shaders/sprite-fragment".shaderExt),
    @[windowId of Texture, depthId],
    @[cameraBinding(), modelsBinding(), texture.binding],
  )) of Rasterizer


let boardRasterizer = spriteRasterizer("textures/board.png")
var pieceRasterizers: Table[PieceCode, Id[Rasterizer]]
for code in ["wP","wN","wB","wR","wQ","wK","bP","bN","bB","bR","bQ","bK"]:
  pieceRasterizers[code] = spriteRasterizer("textures/pieces/" & code & ".png")


# Sprite del tablero, centrado y del tamaño Board.
let boardSprite = makeSprite(
  renders(boardRasterizer),
  name = "board",
  transform = transform(vec3(0, 0, -0.2), vec3(0, 0, 0).anglesToQuat, vec3(Board, Board, 1)),
)
world.setParentOf(world.add(boardSprite, Immediate) of Node, rootId)


# Pool de sprites por tipo de pieza. Nunca se borran (borrar+recrear cada FEN
# corrompe el render): se crean una vez y se REPOSICIONAN; los sobrantes se mandan
# fuera de pantalla.
let cell = Board / Files.float32
const Offscreen = vec3(-10000.0'f32, -10000.0'f32, -0.1'f32)
var piecePool: Table[PieceCode, seq[EntityId]]

proc makePieceSprite(code: PieceCode): EntityId =
  let sprite = makeSprite(
    renders(pieceRasterizers[code]),
    name = "piece",
    transform = transform(Offscreen, vec3(0, 0, 0).anglesToQuat, vec3(cell, cell, 1)),
  )
  result = world.add(sprite, Immediate)
  world.setParentOf(result of Node, rootId)

proc moveTo(id: EntityId, pos: Vec3) =
  for tr in world.write(id of Transform):
    tr.position = pos

## Centro de una casilla LÓGICA en coords de cámara, según la orientación.
proc viewCenter(file, rank: int): tuple[x, y: float32] =
  if flipped: squareCenter(Files - 1 - file, Ranks - 1 - rank, Board)
  else: squareCenter(file, rank, Board)

proc applyPlacement(fen: string) =
  var used: Table[PieceCode, int]
  occupancy.clear()
  for p in parseFen(fen):
    occupancy[(file: p.file, rank: p.rank)] = p.piece
    let code = p.piece
    let idx = used.getOrDefault(code, 0)
    if not piecePool.hasKey(code): piecePool[code] = @[]
    while idx >= piecePool[code].len:
      piecePool[code].add makePieceSprite(code)
    let (x, y) = viewCenter(p.file, p.rank)
    moveTo(piecePool[code][idx], vec3(x, y, -0.1))
    used[code] = idx + 1
  # Ocultar los sprites sobrantes de cada tipo.
  for code, ids in piecePool:
    for i in used.getOrDefault(code, 0) ..< ids.len:
      moveTo(ids[i], Offscreen)


# Marcadores: última jugada (2) y casilla seleccionada (1). Van entre el tablero
# (z=-0.2) y las piezas (z=-0.1); se dibujan ANTES que las piezas para que el
# blending no pelee con el depth de los quads de las piezas.
let highlightRasterizer = spriteRasterizer("textures/highlight.png")
let selectRasterizer = spriteRasterizer("textures/select.png")

proc makeMarkerSprite(rast: Id[Rasterizer]): EntityId =
  let sprite = makeSprite(
    renders(rast),
    name = "marker",
    transform = transform(Offscreen, vec3(0, 0, 0).anglesToQuat, vec3(cell, cell, 1)),
  )
  result = world.add(sprite, Immediate)
  world.setParentOf(result of Node, rootId)

let lastMoveMarkers = [makeMarkerSprite(highlightRasterizer), makeMarkerSprite(highlightRasterizer)]
let selectMarker = makeMarkerSprite(selectRasterizer)

proc refreshMarkers() =
  for i, id in lastMoveMarkers:
    if i < lastMove.len:
      let (x, y) = viewCenter(lastMove[i].file, lastMove[i].rank)
      moveTo(id, vec3(x, y, -0.15'f32))
    else:
      moveTo(id, Offscreen)
  if selected.isSome:
    let (x, y) = viewCenter(selected.get.file, selected.get.rank)
    moveTo(selectMarker, vec3(x, y, -0.14'f32))
  else:
    moveTo(selectMarker, Offscreen)

applyPlacement(pendingFen)
var renderedFen = pendingFen
world.consolidate()


# --- Lógica de input ------------------------------------------------------

## ¿Hay una pieza MÍA (según orientación) en esa casilla lógica?
proc myPieceAt(sq: tuple[file, rank: int]): bool =
  let code = occupancy.getOrDefault(sq)
  code.len > 0 and code[0] == (if flipped: 'b' else: 'w')

proc handleClick(px, py: float32) =
  if not interactive: return
  let hit = pixelToSquare(px, py, WinW.float32, WinH.float32, Board)
  if hit.isNone: return
  var sq = hit.get
  if flipped:  # la vista está dada vuelta: volver a coordenadas lógicas
    sq = (file: Files - 1 - sq.file, rank: Ranks - 1 - sq.rank)
  if selected.isNone:
    if myPieceAt(sq): selected = some(sq)      # seleccionar pieza propia
  elif sq == selected.get:
    selected = none(tuple[file, rank: int])    # deseleccionar
  elif myPieceAt(sq):
    selected = some(sq)                        # cambiar de pieza
  else:
    let a = selected.get
    emitMove(squareName(a.file, a.rank), squareName(sq.file, sq.rank))
    selected = none(tuple[file, rank: int])
  boardDirty = true


# JS → Nim: el shell pasa el clic del canvas (px en coords de ventana 960x540).
proc clickAt(px, py: cfloat) {.exportc.} =
  handleClick(px.float32, py.float32)


# --- Loop -----------------------------------------------------------------

proc frame() =
  windows.beginFrame(world)
  graphics.beginFrame(world)
  time.process()

  if pendingFen != renderedFen or boardDirty:
    applyPlacement(pendingFen)
    renderedFen = pendingFen
    refreshMarkers()
    boardDirty = false

  scene.process(world)
  graphics.process(world)

  graphics.clear(world, windowId of Texture, depthId)
  graphics.render(world, raster(boardRasterizer, spriteCameraId, drawModels()))
  graphics.render(world, raster(highlightRasterizer, spriteCameraId, drawModels()))
  graphics.render(world, raster(selectRasterizer, spriteCameraId, drawModels()))
  for code, rast in pieceRasterizers:
    graphics.render(world, raster(rast, spriteCameraId, drawModels()))

  graphics.endFrame(world)
  windows.endFrame(world)
  world.consolidate()


when defined(emscripten):
  proc emscripten_set_main_loop(f: proc() {.cdecl.}, fps: cint, infinite: cint)
    {.importc, header: "<emscripten.h>".}
  proc frameCdecl() {.cdecl.} = frame()
  emscripten_set_main_loop(frameCdecl, 0.cint, 1.cint)
else:
  while not windows.shouldClose(world):
    frame()
  graphics.cleanup()
  windows.cleanup(world)
