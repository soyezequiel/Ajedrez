## Cliente de ajedrez 2D sobre Vexel.
##
## Vexel renderiza el tablero, piezas, coordenadas, selección, destinos legales,
## arrastre, estelas, impactos y cuenta regresiva. El shell web solamente entrega
## eventos crudos y mantiene la conexión con el servidor autoritativo.

import vexel
import chessboard
import std/[math, options, strutils, tables]


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

  BoardSquare = tuple[file, rank: int]

  PendingMove = object
    active: bool
    mover: EntityId
    captured: EntityId
    hasCaptured: bool
    fromSq, toSq: BoardSquare

  RemoteRequest = object
    active: bool
    fromSq, toSq: BoardSquare
    capture: bool

  MoveAnimation = object
    active: bool
    entity: EntityId
    fromX, fromY, toX, toY: float32
    elapsed, duration: float32
    impactSq: BoardSquare
    capture: bool

  TrailEffect = object
    entity: EntityId
    active: bool
    elapsed: float32


proc shaderExt(shader: string): string =
  shader & (when defined(emscripten): ".wgsl" else: ".glsl")


const
  WinW = 600
  WinH = 600
  Board = 560.0'f32
  DragThreshold = 5.0'f32
  Offscreen = vec3(-10000.0'f32, -10000.0'f32, -0.1'f32)


var
  pendingFen = StartFen
  renderedFen = ""
  interactive = false
  flipped = false
  selected = none(BoardSquare)
  lastMove: seq[BoardSquare] = @[]
  legalTargets: Table[BoardSquare, seq[BoardSquare]]
  occupancy: Table[BoardSquare, PieceCode]
  entityAt: Table[BoardSquare, EntityId]
  placementDirty = true
  markersDirty = true
  keyboardFocused = false
  keyboardSquare: BoardSquare = (file: 4, rank: 6) # e2

  dragging = false
  dragEntity: EntityId
  dragFrom: BoardSquare
  dragStartedSelected = false
  dragMoved = false
  dragStartX, dragStartY: float32
  dragLastX, dragLastY: float32
  hoverSquare = none(BoardSquare)
  clickTarget = none(BoardSquare)
  pendingMove: PendingMove
  remoteRequest: RemoteRequest
  moveAnimation: MoveAnimation

  impactActive = false
  impactElapsed = 0.0'f32
  impactX, impactY = 0.0'f32
  impactCapture = false
  liftActive = false
  liftElapsed = 0.0'f32
  liftX, liftY = 0.0'f32
  trailCursor = 0

  countdownActive = false
  countdownElapsed = 0.0'f32
  countdownStage = -1


when defined(emscripten):
  proc emscripten_run_script(script: cstring) {.importc, header: "<emscripten.h>".}


proc emitMove(fromSq, toSq: BoardSquare) =
  let a = squareName(fromSq.file, fromSq.rank)
  let b = squareName(toSq.file, toSq.rank)
  when defined(emscripten):
    emscripten_run_script(("window.__chess.onMove('" & a & "','" & b & "','');").cstring)
  else:
    echo "move ", a, " -> ", b


proc emitFeedback(kind: string) =
  when defined(emscripten):
    emscripten_run_script(("window.__chess.onFeedback('" & kind & "');").cstring)


proc emitReady() =
  when defined(emscripten):
    emscripten_run_script("window.__chess.onVexelReady();")


# ------------------------------------------------------------------ escena

var windows = windowManager()
let time = startTime()
var scene = scene()
var world = World()
var graphics = startWgpuGraphics(windows)

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


proc spriteRasterizer(texturePath: string): Id[Rasterizer] =
  let texture = world.add(loadTexture(texturePath)) of Texture
  world.add(rasterizer(
    shader[Input, Interface]("shaders/sprite-vertex".shaderExt),
    shader[Interface, Output]("shaders/sprite-fragment".shaderExt),
    @[windowId of Texture, depthId],
    @[cameraBinding(), modelsBinding(), texture.binding],
  )) of Rasterizer


proc makeSpriteEntity(
  rasterizerId: Id[Rasterizer],
  name: string,
  position = Offscreen,
  scale = vec3(1.0'f32, 1.0'f32, 1.0'f32),
): EntityId =
  let sprite = makeSprite(
    renders(rasterizerId),
    name = name,
    transform = transform(position, vec3(0, 0, 0).anglesToQuat, scale),
  )
  result = world.add(sprite, Immediate)
  world.setParentOf(result of Node, rootId)


proc setTransform(
  id: EntityId,
  position: Vec3,
  scale: Vec3,
  angle = 0.0'f32,
) =
  for tr in world.write(id of Transform):
    tr.position = position
    tr.scale = scale
    tr.rotation = vec3(0, 0, angle).anglesToQuat


proc moveTo(id: EntityId, position: Vec3) =
  for tr in world.write(id of Transform):
    tr.position = position


proc scaleTo(id: EntityId, scale: Vec3) =
  for tr in world.write(id of Transform):
    tr.scale = scale


let boardRasterizer = spriteRasterizer("textures/board.png")
var pieceRasterizers: Table[PieceCode, Id[Rasterizer]]
for code in ["wP","wN","wB","wR","wQ","wK","bP","bN","bB","bR","bQ","bK"]:
  pieceRasterizers[code] = spriteRasterizer("textures/pieces/" & code & ".png")

let highlightRasterizer = spriteRasterizer("textures/highlight.png")
let selectRasterizer = spriteRasterizer("textures/select.png")
let legalRasterizer = spriteRasterizer("textures/effects/legal.png")
let captureRasterizer = spriteRasterizer("textures/effects/capture.png")
let ringRasterizer = spriteRasterizer("textures/effects/ring.png")
let sparkRasterizer = spriteRasterizer("textures/effects/spark.png")
let trailRasterizer = spriteRasterizer("textures/effects/trail.png")
let veilRasterizer = spriteRasterizer("textures/effects/veil.png")
let coordsWhiteRasterizer = spriteRasterizer("textures/coordinates/white.png")
let coordsBlackRasterizer = spriteRasterizer("textures/coordinates/black.png")

var countdownRasterizers: Table[string, Id[Rasterizer]]
for label in ["3", "2", "1", "go"]:
  countdownRasterizers[label] = spriteRasterizer("textures/countdown/" & label & ".png")

discard makeSpriteEntity(
  boardRasterizer,
  "board",
  vec3(0, 0, -0.2),
  vec3(Board, Board, 1),
)

let cell = Board / Files.float32
var piecePool: Table[PieceCode, seq[EntityId]]

proc makePieceSprite(code: PieceCode): EntityId =
  makeSpriteEntity(pieceRasterizers[code], "piece " & code, Offscreen, vec3(cell, cell, 1))

let lastMoveMarkers = [
  makeSpriteEntity(highlightRasterizer, "last move"),
  makeSpriteEntity(highlightRasterizer, "last move"),
]
let selectMarker = makeSpriteEntity(selectRasterizer, "selection")
let keyboardMarker = makeSpriteEntity(selectRasterizer, "keyboard focus")
let hoverMarker = makeSpriteEntity(ringRasterizer, "destination preview")

var legalMarkers: seq[EntityId]
var captureMarkers: seq[EntityId]
for i in 0..<32:
  legalMarkers.add makeSpriteEntity(legalRasterizer, "legal target")
  captureMarkers.add makeSpriteEntity(captureRasterizer, "capture target")

let coordsWhite = makeSpriteEntity(coordsWhiteRasterizer, "coordinates white", vec3(0, 0, -0.04), vec3(WinW.float32, WinH.float32, 1))
let coordsBlack = makeSpriteEntity(coordsBlackRasterizer, "coordinates black", Offscreen, vec3(WinW.float32, WinH.float32, 1))

var trails: seq[TrailEffect]
for i in 0..<12:
  trails.add TrailEffect(entity: makeSpriteEntity(trailRasterizer, "drag trail"))

var impactRings: seq[EntityId]
for i in 0..<3: impactRings.add makeSpriteEntity(ringRasterizer, "impact ring")
var impactSparks: seq[EntityId]
for i in 0..<16: impactSparks.add makeSpriteEntity(sparkRasterizer, "impact spark")
let liftRing = makeSpriteEntity(ringRasterizer, "piece lift")

let countdownVeil = makeSpriteEntity(veilRasterizer, "countdown veil")
var countdownEntities: Table[string, EntityId]
for label, rasterizerId in countdownRasterizers:
  countdownEntities[label] = makeSpriteEntity(rasterizerId, "countdown " & label)


# -------------------------------------------------------------- coordenadas

proc viewCenter(sq: BoardSquare): tuple[x, y: float32] =
  if flipped: squareCenter(Files - 1 - sq.file, Ranks - 1 - sq.rank, Board)
  else: squareCenter(sq.file, sq.rank, Board)


proc logicalSquareAt(px, py: float32): Option[BoardSquare] =
  let hit = pixelToSquare(px, py, WinW.float32, WinH.float32, Board)
  if hit.isNone: return none(BoardSquare)
  let sq = hit.get
  if flipped: some((file: Files - 1 - sq.file, rank: Ranks - 1 - sq.rank))
  else: some((file: sq.file, rank: sq.rank))


proc pointerPosition(px, py: float32, z = -0.02'f32): Vec3 =
  vec3(px - WinW.float32 / 2, WinH.float32 / 2 - py, z)


proc isMine(sq: BoardSquare): bool =
  let code = occupancy.getOrDefault(sq)
  code.len > 0 and code[0] == (if flipped: 'b' else: 'w')


proc hasLegalMoves(sq: BoardSquare): bool =
  legalTargets.hasKey(sq) and legalTargets[sq].len > 0


proc isLegal(fromSq, toSq: BoardSquare): bool =
  if not legalTargets.hasKey(fromSq): return false
  for target in legalTargets[fromSq]:
    if target == toSq: return true
  false


proc capturedSquare(fromSq, toSq: BoardSquare): Option[BoardSquare] =
  if occupancy.hasKey(toSq): return some(toSq)
  let code = occupancy.getOrDefault(fromSq)
  if code.len == 2 and code[1] == 'P' and fromSq.file != toSq.file:
    return some((file: toSq.file, rank: fromSq.rank))
  none(BoardSquare)


# --------------------------------------------------------------- colocación

proc applyPlacement(fen: string) =
  var used: Table[PieceCode, int]
  occupancy.clear()
  entityAt.clear()
  for p in parseFen(fen):
    let sq: BoardSquare = (file: p.file, rank: p.rank)
    occupancy[sq] = p.piece
    let code = p.piece
    let index = used.getOrDefault(code, 0)
    if not piecePool.hasKey(code): piecePool[code] = @[]
    while index >= piecePool[code].len:
      piecePool[code].add makePieceSprite(code)
    let entity = piecePool[code][index]
    let (x, y) = viewCenter(sq)
    setTransform(entity, vec3(x, y, -0.1), vec3(cell, cell, 1))
    entityAt[sq] = entity
    used[code] = index + 1
  for code, entities in piecePool:
    for index in used.getOrDefault(code, 0) ..< entities.len:
      moveTo(entities[index], Offscreen)


proc refreshCoordinates() =
  if flipped:
    moveTo(coordsWhite, Offscreen)
    moveTo(coordsBlack, vec3(0, 0, -0.04))
  else:
    moveTo(coordsBlack, Offscreen)
    moveTo(coordsWhite, vec3(0, 0, -0.04))


proc hideMarkers(markers: seq[EntityId]) =
  for marker in markers: moveTo(marker, Offscreen)


proc refreshMarkers() =
  hideMarkers(legalMarkers)
  hideMarkers(captureMarkers)
  moveTo(selectMarker, Offscreen)
  moveTo(keyboardMarker, Offscreen)
  moveTo(hoverMarker, Offscreen)

  for index, marker in lastMoveMarkers:
    if index < lastMove.len:
      let (x, y) = viewCenter(lastMove[index])
      setTransform(marker, vec3(x, y, -0.15), vec3(cell, cell, 1))
    else:
      moveTo(marker, Offscreen)

  if selected.isSome:
    let sq = selected.get
    let (x, y) = viewCenter(sq)
    setTransform(selectMarker, vec3(x, y, -0.13), vec3(cell, cell, 1))
    if legalTargets.hasKey(sq):
      var legalIndex = 0
      var captureIndex = 0
      for target in legalTargets[sq]:
        let (tx, ty) = viewCenter(target)
        if capturedSquare(sq, target).isSome:
          if captureIndex < captureMarkers.len:
            setTransform(captureMarkers[captureIndex], vec3(tx, ty, -0.07), vec3(cell, cell, 1))
            inc captureIndex
        elif legalIndex < legalMarkers.len:
          setTransform(legalMarkers[legalIndex], vec3(tx, ty, -0.13), vec3(cell * 0.72, cell * 0.72, 1))
          inc legalIndex

  if keyboardFocused:
    let (x, y) = viewCenter(keyboardSquare)
    setTransform(keyboardMarker, vec3(x, y, -0.06), vec3(cell * 0.92, cell * 0.92, 1))

  if hoverSquare.isSome:
    let (x, y) = viewCenter(hoverSquare.get)
    setTransform(hoverMarker, vec3(x, y, -0.04), vec3(cell * 1.18, cell * 1.18, 1))

  markersDirty = false


# ---------------------------------------------------------------- efectos

proc spawnLift(sq: BoardSquare) =
  let (x, y) = viewCenter(sq)
  liftX = x
  liftY = y
  liftElapsed = 0
  liftActive = true


proc spawnTrail(fromX, fromY, toX, toY: float32) =
  let dx = toX - fromX
  let dy = toY - fromY
  let distance = sqrt(dx * dx + dy * dy)
  if distance < 7: return
  let effectIndex = trailCursor mod trails.len
  trailCursor = (trailCursor + 1) mod trails.len
  trails[effectIndex].active = true
  trails[effectIndex].elapsed = 0
  let midpoint = vec3((fromX + toX) / 2, (fromY + toY) / 2, -0.025)
  setTransform(trails[effectIndex].entity, midpoint, vec3(distance, 8, 1), arctan2(dy, dx))


proc spawnImpact(sq: BoardSquare, capture: bool) =
  let (x, y) = viewCenter(sq)
  impactX = x
  impactY = y
  impactCapture = capture
  impactElapsed = 0
  impactActive = true


proc updateEffects(dt: float32) =
  for effect in trails.mitems:
    if not effect.active: continue
    effect.elapsed += dt
    if effect.elapsed >= 0.24:
      effect.active = false
      moveTo(effect.entity, Offscreen)

  if liftActive:
    liftElapsed += dt
    let progress = min(liftElapsed / 0.36'f32, 1.0'f32)
    let size = cell * (0.38'f32 + progress * 1.2'f32)
    setTransform(liftRing, vec3(liftX, liftY, -0.035), vec3(size, size, 1))
    if progress >= 1:
      liftActive = false
      moveTo(liftRing, Offscreen)

  if impactActive:
    impactElapsed += dt
    let progress = min(impactElapsed / 0.58'f32, 1.0'f32)
    for index, ring in impactRings:
      let delayed = max(0.0'f32, progress - index.float32 * 0.11'f32)
      let size = cell * (0.22'f32 + delayed * (if impactCapture: 1.9'f32 else: 1.55'f32))
      setTransform(ring, vec3(impactX, impactY, -0.015 + index.float32 * 0.001), vec3(size, size, 1))
    for index, spark in impactSparks:
      let angle = index.float32 * (2.0'f32 * PI.float32 / impactSparks.len.float32) + (index mod 2).float32 * 0.12'f32
      let radius = progress * cell * (if impactCapture: 1.0'f32 else: 0.72'f32) * (0.78'f32 + (index mod 4).float32 * 0.08'f32)
      let size = max(3.0'f32, (1.0'f32 - progress) * 18.0'f32)
      setTransform(spark, vec3(impactX + cos(angle) * radius, impactY + sin(angle) * radius, -0.01), vec3(size, size, 1))
    if progress >= 1:
      impactActive = false
      hideMarkers(impactRings)
      hideMarkers(impactSparks)


proc updateMoveAnimation(dt: float32) =
  if not moveAnimation.active: return
  moveAnimation.elapsed += dt
  let progress = min(moveAnimation.elapsed / moveAnimation.duration, 1.0'f32)
  let eased = 1.0'f32 - pow(1.0'f32 - progress, 3.0'f32)
  let x = moveAnimation.fromX + (moveAnimation.toX - moveAnimation.fromX) * eased
  let y = moveAnimation.fromY + (moveAnimation.toY - moveAnimation.fromY) * eased
  setTransform(moveAnimation.entity, vec3(x, y, -0.03), vec3(cell * (1.0'f32 + sin(progress * PI.float32) * 0.08'f32), cell * (1.0'f32 + sin(progress * PI.float32) * 0.08'f32), 1))
  if progress >= 1:
    moveAnimation.active = false
    scaleTo(moveAnimation.entity, vec3(cell, cell, 1))
    spawnImpact(moveAnimation.impactSq, moveAnimation.capture)


proc hideCountdown() =
  moveTo(countdownVeil, Offscreen)
  for _, entity in countdownEntities: moveTo(entity, Offscreen)


proc updateCountdown(dt: float32) =
  if not countdownActive: return
  countdownElapsed += dt
  let stage = int(countdownElapsed / 0.32'f32)
  if stage >= 4:
    countdownActive = false
    countdownStage = -1
    hideCountdown()
    return
  if stage != countdownStage:
    countdownStage = stage
    for _, entity in countdownEntities: moveTo(entity, Offscreen)
  let label = ["3", "2", "1", "go"][stage]
  let local = (countdownElapsed - stage.float32 * 0.32'f32) / 0.32'f32
  let size = (if label == "go": 250.0'f32 else: 190.0'f32) * (0.82'f32 + min(local, 1.0'f32) * 0.18'f32)
  setTransform(countdownVeil, vec3(0, 0, -0.005), vec3(WinW.float32, WinH.float32, 1))
  setTransform(countdownEntities[label], vec3(0, 0, 0), vec3(size, size, 1))


# -------------------------------------------------------------- movimientos

proc hideCaptured(fromSq, toSq: BoardSquare): tuple[hasCaptured: bool, entity: EntityId] =
  let captureSq = capturedSquare(fromSq, toSq)
  if captureSq.isSome and entityAt.hasKey(captureSq.get):
    result.hasCaptured = true
    result.entity = entityAt[captureSq.get]
    moveTo(result.entity, Offscreen)


proc commitMove(fromSq, toSq: BoardSquare) =
  if not entityAt.hasKey(fromSq): return
  let mover = entityAt[fromSq]
  let captured = hideCaptured(fromSq, toSq)
  let (x, y) = viewCenter(toSq)
  setTransform(mover, vec3(x, y, -0.03), vec3(cell, cell, 1))
  pendingMove = PendingMove(
    active: true,
    mover: mover,
    captured: captured.entity,
    hasCaptured: captured.hasCaptured,
    fromSq: fromSq,
    toSq: toSq,
  )
  selected = none(BoardSquare)
  hoverSquare = none(BoardSquare)
  dragging = false
  markersDirty = true
  spawnImpact(toSq, captured.hasCaptured)
  emitFeedback("drop")
  emitMove(fromSq, toSq)


proc restorePendingMove(animated: bool) =
  if not pendingMove.active: return
  let (fromX, fromY) = viewCenter(pendingMove.fromSq)
  if animated:
    var currentX = fromX
    var currentY = fromY
    let tr = world.read(pendingMove.mover of Transform)
    currentX = tr.position.x
    currentY = tr.position.y
    moveAnimation = MoveAnimation(
      active: true,
      entity: pendingMove.mover,
      fromX: currentX,
      fromY: currentY,
      toX: fromX,
      toY: fromY,
      elapsed: 0,
      duration: 0.18,
      impactSq: pendingMove.fromSq,
      capture: false,
    )
  else:
    setTransform(pendingMove.mover, vec3(fromX, fromY, -0.1), vec3(cell, cell, 1))
  if pendingMove.hasCaptured:
    let captureSq = capturedSquare(pendingMove.fromSq, pendingMove.toSq)
    if captureSq.isSome:
      let (x, y) = viewCenter(captureSq.get)
      setTransform(pendingMove.captured, vec3(x, y, -0.1), vec3(cell, cell, 1))
  pendingMove.active = false


# --------------------------------------------------------------- interop JS

proc applyFen(fen: cstring) {.exportc.} =
  pendingFen = $fen
  remoteRequest.active = false


proc applyFenAnimated(fen, fromName, toName: cstring, capture: cint) {.exportc.} =
  let fromSq = parseSquare($fromName)
  let toSq = parseSquare($toName)
  if fromSq.isSome and toSq.isSome:
    remoteRequest = RemoteRequest(
      active: true,
      fromSq: fromSq.get,
      toSq: toSq.get,
      capture: capture != 0,
    )
  pendingFen = $fen


proc setInteractive(on: cint) {.exportc.} =
  interactive = on != 0
  if not interactive and not pendingMove.active and not dragging:
    selected = none(BoardSquare)
    markersDirty = true


proc setOrientation(black: cint) {.exportc.} =
  let next = black != 0
  if next != flipped:
    flipped = next
    placementDirty = true
    markersDirty = true
    refreshCoordinates()


proc highlight(squares: cstring) {.exportc.} =
  lastMove.setLen(0)
  for token in ($squares).split(' '):
    let sq = parseSquare(token)
    if sq.isSome: lastMove.add sq.get
  markersDirty = true


proc setLegalMoves(payload: cstring) {.exportc.} =
  legalTargets.clear()
  for entry in ($payload).split(';'):
    if entry.len == 0: continue
    let halves = entry.split(':', maxsplit = 1)
    if halves.len != 2: continue
    let fromSq = parseSquare(halves[0])
    if fromSq.isNone: continue
    var targets: seq[BoardSquare] = @[]
    for token in halves[1].split(','):
      let target = parseSquare(token)
      if target.isSome: targets.add target.get
    if targets.len > 0: legalTargets[fromSq.get] = targets
  markersDirty = true


proc pointerDown(px, py: cfloat) {.exportc.} =
  if not interactive or pendingMove.active: return
  let hit = logicalSquareAt(px.float32, py.float32)
  if hit.isNone: return
  let sq = hit.get
  clickTarget = none(BoardSquare)

  if selected.isSome and sq != selected.get and isLegal(selected.get, sq):
    clickTarget = some(sq)
    return

  if not isMine(sq) or not hasLegalMoves(sq): return
  dragStartedSelected = selected.isSome and selected.get == sq
  selected = some(sq)
  dragFrom = sq
  dragEntity = entityAt[sq]
  dragging = true
  dragMoved = false
  dragStartX = px.float32
  dragStartY = py.float32
  let pos = pointerPosition(px.float32, py.float32)
  dragLastX = pos.x
  dragLastY = pos.y
  hoverSquare = none(BoardSquare)
  scaleTo(dragEntity, vec3(cell * 1.16, cell * 1.16, 1))
  spawnLift(sq)
  markersDirty = true
  emitFeedback("pickup")


proc pointerMove(px, py: cfloat) {.exportc.} =
  if not dragging: return
  let x = px.float32
  let y = py.float32
  if sqrt((x - dragStartX) * (x - dragStartX) + (y - dragStartY) * (y - dragStartY)) > DragThreshold:
    dragMoved = true
  let pos = pointerPosition(x, y)
  moveTo(dragEntity, pos)
  if dragMoved:
    spawnTrail(dragLastX, dragLastY, pos.x, pos.y)
    dragLastX = pos.x
    dragLastY = pos.y
    let hit = logicalSquareAt(x, y)
    let nextHover = if hit.isSome and isLegal(dragFrom, hit.get): hit else: none(BoardSquare)
    if nextHover != hoverSquare:
      hoverSquare = nextHover
      markersDirty = true


proc pointerUp(px, py: cfloat) {.exportc.} =
  if clickTarget.isSome and selected.isSome:
    let target = clickTarget.get
    clickTarget = none(BoardSquare)
    commitMove(selected.get, target)
    return
  if not dragging: return
  dragging = false
  let hit = logicalSquareAt(px.float32, py.float32)
  if dragMoved and hit.isSome and isLegal(dragFrom, hit.get):
    commitMove(dragFrom, hit.get)
    return
  let (x, y) = viewCenter(dragFrom)
  setTransform(dragEntity, vec3(x, y, -0.1), vec3(cell, cell, 1))
  hoverSquare = none(BoardSquare)
  if dragMoved:
    selected = none(BoardSquare)
    emitFeedback("invalid")
  elif dragStartedSelected:
    selected = none(BoardSquare)
  markersDirty = true


proc pointerCancel() {.exportc.} =
  if dragging:
    let (x, y) = viewCenter(dragFrom)
    setTransform(dragEntity, vec3(x, y, -0.1), vec3(cell, cell, 1))
  dragging = false
  clickTarget = none(BoardSquare)
  hoverSquare = none(BoardSquare)
  markersDirty = true


proc keyInput(code: cint) {.exportc.} =
  if not keyboardFocused: return
  if code >= 0 and code <= 3:
    let deltas = [(-1, 0), (1, 0), (0, -1), (0, 1)]
    let delta = deltas[code]
    let direction = if flipped: -1 else: 1
    let nextFile = keyboardSquare.file + delta[0] * direction
    let nextRank = keyboardSquare.rank + delta[1] * direction
    if nextFile in 0..<Files and nextRank in 0..<Ranks:
      keyboardSquare = (file: nextFile, rank: nextRank)
      markersDirty = true
  elif code == 4 and interactive and not pendingMove.active:
    if selected.isSome and isLegal(selected.get, keyboardSquare):
      commitMove(selected.get, keyboardSquare)
    elif isMine(keyboardSquare) and hasLegalMoves(keyboardSquare):
      selected = some(keyboardSquare)
      markersDirty = true
      spawnLift(keyboardSquare)
      emitFeedback("pickup")
  elif code == 5:
    selected = none(BoardSquare)
    markersDirty = true


proc setKeyboardFocus(on: cint) {.exportc.} =
  keyboardFocused = on != 0
  markersDirty = true


proc rejectMove() {.exportc.} =
  restorePendingMove(true)
  selected = none(BoardSquare)
  markersDirty = true
  emitFeedback("invalid")


proc confirmMove() {.exportc.} =
  pendingMove.active = false
  selected = none(BoardSquare)
  markersDirty = true


proc showCountdown() {.exportc.} =
  countdownActive = true
  countdownElapsed = 0
  countdownStage = -1
  hideCountdown()


# ------------------------------------------------------------------- loop

applyPlacement(pendingFen)
renderedFen = pendingFen
refreshCoordinates()
refreshMarkers()
world.consolidate()
emitReady()


proc frame() =
  windows.beginFrame(world)
  graphics.beginFrame(world)
  time.process()

  if pendingFen != renderedFen or placementDirty:
    pendingMove.active = false
    applyPlacement(pendingFen)
    renderedFen = pendingFen
    placementDirty = false
    markersDirty = true
    if remoteRequest.active and entityAt.hasKey(remoteRequest.toSq):
      let entity = entityAt[remoteRequest.toSq]
      let (fromX, fromY) = viewCenter(remoteRequest.fromSq)
      let (toX, toY) = viewCenter(remoteRequest.toSq)
      setTransform(entity, vec3(fromX, fromY, -0.03), vec3(cell, cell, 1))
      moveAnimation = MoveAnimation(
        active: true,
        entity: entity,
        fromX: fromX,
        fromY: fromY,
        toX: toX,
        toY: toY,
        elapsed: 0,
        duration: 0.2,
        impactSq: remoteRequest.toSq,
        capture: remoteRequest.capture,
      )
    remoteRequest.active = false

  if markersDirty: refreshMarkers()
  updateMoveAnimation(time.delta)
  updateEffects(time.delta)
  updateCountdown(time.delta)

  scene.process(world)
  graphics.process(world)

  graphics.clear(world, windowId of Texture, depthId)
  graphics.render(world, raster(boardRasterizer, spriteCameraId, drawModels()))
  if lastMove.len > 0:
    graphics.render(world, raster(highlightRasterizer, spriteCameraId, drawModels()))
  if selected.isSome or keyboardFocused or hoverSquare.isSome:
    graphics.render(world, raster(selectRasterizer, spriteCameraId, drawModels()))
  if selected.isSome:
    graphics.render(world, raster(legalRasterizer, spriteCameraId, drawModels()))
    graphics.render(world, raster(captureRasterizer, spriteCameraId, drawModels()))
  for _, rasterizerId in pieceRasterizers:
    graphics.render(world, raster(rasterizerId, spriteCameraId, drawModels()))
  let coordsRasterizer = if flipped: coordsBlackRasterizer else: coordsWhiteRasterizer
  graphics.render(world, raster(coordsRasterizer, spriteCameraId, drawModels()))
  var trailVisible = false
  for effect in trails:
    if effect.active:
      trailVisible = true
      break
  if trailVisible:
    graphics.render(world, raster(trailRasterizer, spriteCameraId, drawModels()))
  if liftActive or impactActive or hoverSquare.isSome:
    graphics.render(world, raster(ringRasterizer, spriteCameraId, drawModels()))
  if impactActive:
    graphics.render(world, raster(sparkRasterizer, spriteCameraId, drawModels()))
  if countdownActive:
    graphics.render(world, raster(veilRasterizer, spriteCameraId, drawModels()))
    if countdownStage >= 0 and countdownStage < 4:
      let label = ["3", "2", "1", "go"][countdownStage]
      graphics.render(world, raster(countdownRasterizers[label], spriteCameraId, drawModels()))

  graphics.endFrame(world)
  windows.endFrame(world)
  world.consolidate()


when defined(emscripten):
  proc emscripten_set_main_loop(f: proc() {.cdecl.}, fps: cint, infinite: cint)
    {.importc, header: "<emscripten.h>".}
  proc frameCdecl() {.cdecl.} = frame()
  emscripten_set_main_loop(frameCdecl, 0.cint, 1.cint)
else:
  while not windows.shouldClose(world): frame()
  graphics.cleanup()
  windows.cleanup(world)
