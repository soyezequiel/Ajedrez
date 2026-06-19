// Genera los SVG de assets del ajedrez en game/textures/.
//   node tools/gen-assets.mjs
// El tablero es 100% formas (sin fuentes). Las piezas usan los glyphs Unicode de
// ajedrez sólidos (U+265A..F) coloreados (claro con contorno / oscuro relleno),
// igual que el preview. Para PNG ver tools/convert.mjs.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEX = join(ROOT, "textures");
mkdirSync(join(TEX, "pieces"), { recursive: true });

const LIGHT = "#ebecd0";
const DARK = "#739552";
const WHITE_FILL = "#f4f1e9";
const WHITE_STROKE = "#3a3733";
const BLACK_FILL = "#3a3733";
const BLACK_STROKE = "#1f1d1a";

// --- Tablero 512x512 (8x8, casilla 64) ---
const CELL = 64;
let squares = "";
for (let r = 0; r < 8; r++) {
  for (let f = 0; f < 8; f++) {
    const fill = (r + f) % 2 === 0 ? LIGHT : DARK;
    squares += `<rect x="${f * CELL}" y="${r * CELL}" width="${CELL}" height="${CELL}" fill="${fill}"/>`;
  }
}
const board =
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">` +
  squares +
  `</svg>\n`;
writeFileSync(join(TEX, "board.svg"), board);

// --- Piezas (64x64, glyph centrado) ---
const GLYPH = { K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟" };
const FONT = "DejaVu Sans, Noto Sans Symbols2, Segoe UI Symbol, serif";

function pieceSvg(code) {
  const isWhite = code[0] === "w";
  const glyph = GLYPH[code[1]];
  const fill = isWhite ? WHITE_FILL : BLACK_FILL;
  const stroke = isWhite ? WHITE_STROKE : BLACK_STROKE;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
    `<text x="32" y="50" font-family="${FONT}" font-size="50" text-anchor="middle" ` +
    `fill="${fill}" stroke="${stroke}" stroke-width="1.4" ` +
    `paint-order="stroke" stroke-linejoin="round">${glyph}</text>` +
    `</svg>\n`
  );
}

const codes = [];
for (const color of ["w", "b"])
  for (const kind of ["P", "N", "B", "R", "Q", "K"]) codes.push(color + kind);

for (const code of codes) {
  writeFileSync(join(TEX, "pieces", `${code}.svg`), pieceSvg(code));
}

console.log(`Generados: board.svg + ${codes.length} piezas en ${TEX}`);
