# Assets del tablero y piezas


Generados con "claude design". Estilo chess.com (verde), set de 12 piezas en
claras y oscuras.

| Archivo | Tamaño | Uso |
|---|---|---|
| `board.png` | 1024² | Sprite del tablero 8×8 (claro `#ebecd0` / oscuro `#739552`). a1 oscura. |
| `pieces/{w,b}{P,N,B,R,Q,K}.png` | 256² | Un sprite por pieza, fondo transparente. |
| `board.svg`, `pieces/*.svg` | — | Fuente vectorial editable. |


## Regenerar

```bash
node tools/gen-assets.mjs     # SVG → textures/
cd tools && npm i && node convert.mjs   # SVG → PNG (sharp)
```


## Notas

- Las piezas usan los **glyphs Unicode** sólidos de ajedrez (`U+265A..F`)
  coloreados (claras = relleno claro + contorno oscuro; oscuras = relleno
  oscuro). Se rasterizan con la fuente del sistema (DejaVu / Segoe UI Symbol).
- Para un set propio (vectorial, sin dependencia de fuente) en el pulido (M8),
  reemplazar el `<text>` de `pieceSvg` en `tools/gen-assets.mjs` por paths.
- Tamaños pensados para casilla de 64 px (board 512) con margen 2× para nitidez.
