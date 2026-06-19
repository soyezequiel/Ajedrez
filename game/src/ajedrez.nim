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
  WinW = 600          ## canvas cuadrado para embeber prolijo en el shell
  WinH = 600
  Board = 560.0'f32   ## lado del tablero en px (margen chico dentro del canvas)


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

proc applyPlacement(fen: string) =
  var used: Table[PieceCode, int]
  for p in parseFen(fen):
    let code = p.piece
    let idx = used.getOrDefault(code, 0)
    if not piecePool.hasKey(code): piecePool[code] = @[]
    while idx >= piecePool[code].len:
      piecePool[code].add makePieceSprite(code)
    let (x, y) = squareCenter(p.file, p.rank, Board)
    moveTo(piecePool[code][idx], vec3(x, y, -0.1))
    used[code] = idx + 1
  # Ocultar los sprites sobrantes de cada tipo.
  for code, ids in piecePool:
    for i in used.getOrDefault(code, 0) ..< ids.len:
      moveTo(ids[i], Offscreen)

applyPlacement(pendingFen)
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


# JS → Nim: el shell pasa el clic del canvas (px en coords de ventana 960x540).
proc clickAt(px, py: cfloat) {.exportc.} =
  handleClick(px.float32, py.float32)


# --- Loop -----------------------------------------------------------------

proc frame() =
  windows.beginFrame(world)
  graphics.beginFrame(world)
  time.process()

  if pendingFen != renderedFen:
    applyPlacement(pendingFen)
    renderedFen = pendingFen

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
