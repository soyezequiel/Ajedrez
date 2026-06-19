import std/os
import rituals


const binDir = "bin"


## Compila y corre el cliente de ajedrez en escritorio (iteración rápida).
ritual "ajedrez":
  mkdir binDir
  nim.compile "src/ajedrez.nim", "--path:src -o:bin/ajedrez"
  runAfter binDir / "ajedrez", "ajedrez"


## Compila el cliente a web (WASM + WebGPU) y lo sirve.
## Espejo del task `web` de vexel: usa el shell propio con el interop window.__chess.
ritual "web":
  mkdir binDir
  nim.compile "src/ajedrez.nim", "--path:src -d:emscripten"
  cmd "open http://localhost:8080/ajedrez.html", "browser"
  runAfter "python3 -m http.server 8080 -d bin", "serve"
