# Activos “Club Cinemático”

Tablero de nogal/marfil y set Staunton vectorial propio, sin glifos Unicode ni
dependencias de fuentes del sistema.

| Archivo | Tamaño | Uso |
|---|---:|---|
| `board.png` | 1024² | Tablero 8×8 con veta de madera. |
| `pieces/{w,b}{P,N,B,R,Q,K}.png` | 512² | Piezas retina con fondo transparente. |
| `highlight.png`, `select.png` | 64² | Feedback de destino y selección. |
| SVG equivalentes | — | Fuentes vectoriales editables. |

## Regenerar y publicar

Desde `game/`:

```bash
node tools/gen-assets.mjs
cd tools && npm install && node convert.mjs && cd ..
node tools/repack-data.mjs
cd ../web && npm run build
```

`repack-data.mjs` actualiza el paquete Emscripten existente sin recompilar el
WASM. Solo hace falta Emscripten cuando cambia la lógica Nim/Vexel.
