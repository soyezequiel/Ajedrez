import std/[strutils, os]

# Mirror de la config de vexel (define wgpu / wgvkWGSL) + ajustes del ajedrez:
# salida propia, preload de NUESTRAS texturas/shaders, y export de las funciones
# de interop (applyFen / setInteractive) para llamarlas desde JS con ccall.

switch("define", "wgpu")
when not defined(emscripten):
  switch("define", "wgvkWGSL")

when defined(emscripten):
  --os:linux
  --cpu:wasm32
  --cc:clang

  let emscriptenSdk = gorge("em-config EMSCRIPTEN_ROOT").strip()

  switch("clang.exe", emscriptenSdk / "emcc")
  switch("clang.linkerexe", emscriptenSdk / "emcc")

  switch("passL", "-o bin/ajedrez.html")
  switch("passL", "--shell-file shell.html")
  switch("passL", "--preload-file shaders")
  switch("passL", "--preload-file textures")

  # Interop JS↔WASM: exponer las funciones del juego y ccall/cwrap.
  switch("passL", "-sEXPORTED_FUNCTIONS=_main,_applyFen,_setInteractive")
  switch("passL", "-sEXPORTED_RUNTIME_METHODS=ccall,cwrap")
  switch("passL", "-sALLOW_MEMORY_GROWTH=1")

  --d:wasm
  --gc:orc
  --d:useMalloc
else:
  when defined(windows):
    switch("cc", "vcc")
  when defined(macosx):
    switch("passL", "-rpath @executable_path")

# begin Nimble config (version 2)
when withDir(thisDir(), system.fileExists("nimble.paths")):
  include "nimble.paths"
# end Nimble config
