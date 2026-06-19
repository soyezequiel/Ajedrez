packageName   = "ajedrez"
version       = "0.1.0"
author        = "ezequiel"
description   = "Cliente de ajedrez (tablero 2D) sobre el motor Vexel"
license       = "MIT"
srcDir        = "src"
binDir        = "bin"

requires "nim >= 2.0.0"
# Vexel y sus dependencias se resuelven vía el workspace nimby/ritual.
# Ver README de vexel: nimby install + ritual workspace.
requires "vexel"
