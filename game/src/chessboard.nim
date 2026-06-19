## Modelo PURO del tablero para el renderer: parseo de FEN y mapeo casilla↔píxel.
## Sin dependencias de Vexel (lógica testeable de forma aislada).

import std/[options, strutils]


type
  PieceCode* = string ## "wP","bN",… (color + tipo en mayúscula)

  Placement* = object
    file*: int      ## 0..7 (a..h)
    rank*: int      ## 0..7 desde ARRIBA (0 = fila 8 del FEN)
    piece*: PieceCode


const
  Files* = 8
  Ranks* = 8


## Parsea el campo de ubicación de un FEN ("rnbqkbnr/pppppppp/8/…").
## Devuelve una pieza por casilla ocupada. rank 0 = primera fila del FEN (la 8).
proc parseFen*(fen: string): seq[Placement] =
  let placement = fen.split(' ')[0]
  var rank = 0
  for row in placement.split('/'):
    var file = 0
    for ch in row:
      if ch.isDigit:
        file += parseInt($ch)
      else:
        let color = if ch.isUpperAscii: 'w' else: 'b'
        result.add Placement(
          file: file,
          rank: rank,
          piece: color & toUpperAscii(ch),
        )
        file += 1
    rank += 1


## Nombre algebraico de una casilla (file 0..7, rank 0..7 desde arriba) → "e2".
proc squareName*(file, rank: int): string =
  $chr(ord('a') + file) & $(Ranks - rank)


## Centro de una casilla en coords de la cámara ortográfica (origen al centro,
## +y hacia arriba), con blancas abajo. `cell` = lado de casilla en px.
proc squareCenter*(file, rank: int, board: float32): tuple[x, y: float32] =
  let cell = board / Files.float32
  result.x = -board / 2 + cell / 2 + file.float32 * cell
  result.y =  board / 2 - cell / 2 - rank.float32 * cell


## Convierte un píxel de ventana (origen arriba-izquierda, y hacia abajo) a casilla.
## Devuelve none si el clic cae fuera del tablero centrado en la ventana.
proc pixelToSquare*(
  px, py: float32,
  winW, winH, board: float32,
): Option[tuple[file, rank: int]] =
  let
    cell = board / Files.float32
    left = (winW - board) / 2
    top = (winH - board) / 2
    file = int((px - left) / cell)
    rank = int((py - top) / cell)
  if file < 0 or file >= Files or rank < 0 or rank >= Ranks:
    return none(tuple[file, rank: int])
  some((file: file, rank: rank))


const StartFen* = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
