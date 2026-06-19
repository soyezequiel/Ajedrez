## Cliente de ajedrez (tablero 2D) sobre Vexel.
##
## ⚠️  SCAFFOLD SIN COMPILAR — escrito contra la API de los samples de vexel
## (`src/sample/web/web.nim`, `input.nim`). Faltan nim/emscripten en la máquina;
## verificar firmas y ajustar al primer build. Las suposiciones a confirmar van
## marcadas con `# CONFIRMAR`.
##
## Arquitectura: el shell web (TS) maneja login/lobby/apuesta/top y la conexión
## WebSocket; este canvas solo dibuja el tablero y emite intentos de jugada. La
## autoridad de las reglas es el servidor (ver docs/vexel-integration.md).

import vexel
import chessboard
import std/[options, tables]


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
  WinW = 960
  WinH = 540
  Board = 512.0'f32   ## lado del tablero en px (coincide con docs)


# --- Estado compartido con el interop (JS → Nim) --------------------------

var
  pendingFen = StartFen   ## último FEN recibido; el loop lo aplica
  interactive = false     ## ¿es mi turno? (habilita clics)
  selected = none(tuple[file, rank: int])


# JS → Nim: el shell llama Module.ccall("applyFen"/"setInteractive", …)
proc applyFen(fen: cstring) {.exportc.} =
  pendingFen = $fen

proc setInteractive(on: cint) {.exportc.} =
  interactive = on != 0


# Nim → JS: emite un intento de jugada al shell (que lo manda por WebSocket).
proc emitMove(fromSq, toSq: string) =
  when defined(emscripten):
    {.emit: ["window.__chess.onMove(UTF8ToString(", fromSq.cstring,
             "), UTF8ToString(", toSq.cstring, "), '');"].}
  else:
    echo "move ", fromSq, " -> ", toSq   # dev desktop


# --- Setup de escena ------------------------------------------------------

var windows = windowManager()
let time = startTime()
var scene = scene()
var world = World()
var graphics = startWgpuGraphics(windows)
var controllers = makeControllers(MouseController)

let window = makeWindow("Ajedrez", uvec2(WinW, WinH), false, true, main = true)
let windowId = world.add(window, Immediate) of Window
let mouseId = world.add((MouseController(),), Immediate) of MouseController

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
proc spriteRasterizer(texturePath: string): Rasterizer =
  let texture = world.add(loadTexture(texturePath)) of Texture
  world.add(rasterizer(
    shader[Input, Interface]("shaders/sprite-vertex".shaderExt),
    shader[Interface, Output]("shaders/sprite-fragment".shaderExt),
    @[windowId of Texture, depthId],
    @[cameraBinding(), modelsBinding(), texture.binding],
  )) of Rasterizer


let boardRasterizer = spriteRasterizer("textures/board.png")
var pieceRasterizers: Table[PieceCode, Rasterizer]
for code in ["wP","wN","wB","wR","wQ","wK","bP","bN","bB","bR","bQ","bK"]:
  pieceRasterizers[code] = spriteRasterizer("textures/pieces/" & code & ".png")


# Sprite del tablero, centrado y del tamaño Board.
let boardSprite = makeSprite(
  renders(boardRasterizer),
  name = "board",
  transform = transform(vec3(0, 0, 0), vec3(0, 0, 0).anglesToQuat, vec3(Board, Board, 1)),
)
world.setParentOf(world.add(boardSprite, Immediate) of Node, rootId)


# Sprites de piezas: creamos los 32 posibles y los reposicionamos/ocultamos según
# el FEN. CONFIRMAR: cómo ocultar un sprite (¿escala 0? ¿quitar del árbol?).
var pieceSprites: seq[tuple[id: Node, code: PieceCode]]
let cell = Board / Files.float32

proc rebuildFromFen(fen: string) =
  # TODO: en vez de recrear, mantener un pool y mover. Scaffold: recrea simple.
  for ps in pieceSprites:
    world.remove(ps.id)            # CONFIRMAR nombre de la API de borrado
  pieceSprites.setLen(0)
  for p in parseFen(fen):
    let (x, y) = squareCenter(p.file, p.rank, Board)
    let sprite = makeSprite(
      renders(pieceRasterizers[p.piece]),
      name = "piece",
      transform = transform(vec3(x, y, 0.0), vec3(0, 0, 0).anglesToQuat, vec3(cell, cell, 1)),
    )
    let id = world.add(sprite, Immediate) of Node
    world.setParentOf(id, rootId)
    pieceSprites.add (id, p.piece)

rebuildFromFen(pendingFen)
var renderedFen = pendingFen
world.consolidate()


# --- Lógica de input ------------------------------------------------------

proc handleClick(px, py: float32) =
  if not interactive: return
  let sq = pixelToSquare(px, py, WinW.float32, WinH.float32, Board)
  if sq.isNone: return
  if selected.isNone:
    selected = sq                     # primer clic: seleccionar
  else:
    let a = selected.get
    let b = sq.get
    emitMove(squareName(a.file, a.rank), squareName(b.file, b.rank))
    selected = none(tuple[file, rank: int])


# --- Loop -----------------------------------------------------------------

proc frame() =
  windows.beginFrame(world)
  graphics.beginFrame(world)
  controllers.beginFrame(world)
  time.process()

  if pendingFen != renderedFen:
    rebuildFromFen(pendingFen)
    renderedFen = pendingFen

  let mouse = world.read(mouseId)
  if mouse.left.justPressed:
    handleClick(mouse.pointer.position.x, mouse.pointer.position.y)

  scene.process(world)
  graphics.process(world)

  graphics.clear(world, windowId of Texture, depthId)
  graphics.render(world, raster(boardRasterizer, spriteCameraId, drawModels()))
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
