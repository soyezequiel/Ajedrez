// Genera el set Club Cinemático sin depender de fuentes ni glifos del sistema.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEX = join(ROOT, "textures");
mkdirSync(join(TEX, "pieces"), { recursive: true });

const LIGHT = "#dfc59c";
const DARK = "#765039";
const WHITE_FILL = "#f1e5cf";
const WHITE_STROKE = "#3b2b20";
const BLACK_FILL = "#17241d";
const BLACK_STROKE = "#07100b";

const CELL = 64;
let squares = "";
for (let rank = 0; rank < 8; rank++) {
  for (let file = 0; file < 8; file++) {
    const fill = (rank + file) % 2 === 0 ? LIGHT : DARK;
    squares += `<rect x="${file * CELL}" y="${rank * CELL}" width="${CELL}" height="${CELL}" fill="${fill}"/>`;
  }
}
const board = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><pattern id="grain" width="47" height="47" patternUnits="userSpaceOnUse" patternTransform="rotate(11)"><path d="M0 8 Q12 4 24 8T48 8M0 31 Q15 27 30 31T60 31" fill="none" stroke="#fff" stroke-opacity=".04" stroke-width="1"/></pattern></defs>
  ${squares}<rect width="512" height="512" fill="url(#grain)"/>
</svg>\n`;
writeFileSync(join(TEX, "board.svg"), board);
writeFileSync(join(TEX, "highlight.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="3" fill="#e6b74f" fill-opacity=".34"/><rect x="2" y="2" width="60" height="60" rx="2" fill="none" stroke="#f2d28d" stroke-opacity=".32" stroke-width="2"/></svg>\n`);
writeFileSync(join(TEX, "select.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="3" fill="#f4efe4" fill-opacity=".16"/><rect x="2" y="2" width="60" height="60" rx="2" fill="none" stroke="#d8a94e" stroke-opacity=".72" stroke-width="3"/></svg>\n`);

function body(kind) {
  const shapes = {
    P: `<circle cx="32" cy="17" r="8"/><path d="M25 25h14l3 17H22z"/><path d="M18 44h28l3 7H15z"/><rect x="12" y="51" width="40" height="6" rx="2"/>`,
    R: `<path d="M17 10h7v6h5v-6h6v6h5v-6h7v13H17z"/><path d="M21 23h22l-3 23H24z"/><path d="M18 45h28l3 7H15z"/><rect x="12" y="52" width="40" height="5" rx="2"/>`,
    N: `<path d="M18 49c3-12 5-20 12-27l-4-9 11 4 6 8c4 7 2 17-4 23l-7-8-8 9z"/><path d="M23 30c5-1 9-4 13-8" fill="none"/><circle cx="37" cy="25" r="1.7"/><path d="M16 49h31l4 8H12z"/>`,
    B: `<path d="M32 8c8 7 11 13 8 19-2 4-5 6-8 8-4-2-7-4-9-8-3-6 1-12 9-19z"/><path d="M33 13l-6 14" fill="none"/><path d="M24 34h16l4 13H20z"/><path d="M17 47h30l4 10H13z"/>`,
    Q: `<path d="M16 22l4-11 8 10 4-13 5 13 8-10 3 11-7 13H23z"/><circle cx="20" cy="10" r="3"/><circle cx="32" cy="7" r="3"/><circle cx="45" cy="10" r="3"/><path d="M23 34h18l4 14H19z"/><path d="M15 48h34l4 9H11z"/>`,
    K: `<path d="M29 7h6v7h7v6h-7v7h-6v-7h-7v-6h7z"/><path d="M21 27c4-5 18-5 22 0l-4 9H25z"/><path d="M24 35h16l4 13H20z"/><path d="M15 48h34l4 9H11z"/>`,
  };
  return shapes[kind];
}

function pieceSvg(code) {
  const isWhite = code[0] === "w";
  const fill = isWhite ? WHITE_FILL : BLACK_FILL;
  const stroke = isWhite ? WHITE_STROKE : BLACK_STROKE;
  const highlight = isWhite ? "#fff8e9" : "#314b3b";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <defs><linearGradient id="face" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${highlight}"/><stop offset="1" stop-color="${fill}"/></linearGradient></defs>
    <g fill="url(#face)" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${body(code[1])}</g>
  </svg>\n`;
}

const codes = [];
for (const color of ["w", "b"])
  for (const kind of ["P", "N", "B", "R", "Q", "K"]) codes.push(color + kind);
for (const code of codes) writeFileSync(join(TEX, "pieces", `${code}.svg`), pieceSvg(code));

console.log(`Generados: board, marcadores y ${codes.length} piezas Club Cinemático en ${TEX}`);
