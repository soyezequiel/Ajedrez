// Genera el set Club Cinemático sin depender de fuentes ni glifos del sistema.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEX = join(ROOT, "textures");
mkdirSync(join(TEX, "pieces"), { recursive: true });

const LIGHT = "#dfc59c";
const DARK = "#765039";
const WHITE_FILL = "#f3e7d0";
const WHITE_STROKE = "#34251c";
const BLACK_FILL = "#20372b";
const BLACK_STROKE = "#07130d";

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
    // Cada silueta tiene una altura, corona y cuerpo propios para poder
    // reconocerla incluso a 48 px y durante un arrastre rápido.
    P: `<circle cx="32" cy="17" r="8.5"/><path d="M26 25h12l2 5-4 4 5 12H23l5-12-4-4z"/><path d="M19 45h26l4 7H15z"/><rect x="12" y="52" width="40" height="5" rx="2"/>`,
    R: `<path d="M14 10h8v7h6v-7h8v7h6v-7h8v15H14z"/><rect x="19" y="25" width="26" height="6" rx="1"/><path d="M22 31h20l-3 15H25z"/><path d="M17 45h30l4 7H13z"/><rect x="10" y="52" width="44" height="5" rx="2"/>`,
    N: `<path d="M16 48c2-11 6-21 14-29l-3-9 9 4 4 5c9 5 11 16 5 25l-5 6-10-12-7 10z"/><path d="M22 29c6-1 11-5 15-10" fill="none"/><path d="M39 23l5 4-5 2" fill="none"/><circle cx="38" cy="22" r="2"/><path d="M15 48h34l4 9H11z"/>`,
    B: `<path d="M32 6c9 8 13 15 10 22-2 4-5 7-10 10-5-3-8-6-10-10-3-7 1-14 10-22z"/><path d="M35 12L27 29" fill="none"/><path d="M24 37h16l4 10H20z"/><path d="M16 47h32l4 10H12z"/>`,
    Q: `<path d="M13 22l5-12 9 10 5-14 5 14 9-10 5 12-8 14H21z"/><circle cx="18" cy="9" r="3"/><circle cx="32" cy="5" r="3"/><circle cx="46" cy="9" r="3"/><path d="M22 35h20l4 13H18z"/><path d="M14 48h36l4 9H10z"/>`,
    K: `<path d="M28 5h8v8h8v7h-8v8h-8v-8h-8v-7h8z"/><path d="M20 30c3-4 8-6 12-6s9 2 12 6l-5 9H25z"/><path d="M23 38h18l4 10H19z"/><path d="M14 48h36l4 9H10z"/>`,
  };
  return shapes[kind];
}

function details(kind) {
  const shapes = {
    P: `<path d="M26 30h12M24 46h16"/>`,
    R: `<path d="M19 25h26M22 31h20M18 46h28"/>`,
    N: `<path d="M23 48h24"/>`,
    B: `<path d="M24 38h16M21 47h22"/>`,
    Q: `<path d="M21 35h22M20 48h24"/>`,
    K: `<path d="M25 38h14M20 48h24"/>`,
  };
  return shapes[kind];
}

function pieceSvg(code) {
  const isWhite = code[0] === "w";
  const fill = isWhite ? WHITE_FILL : BLACK_FILL;
  const stroke = isWhite ? WHITE_STROKE : BLACK_STROKE;
  const highlight = isWhite ? "#fffaf0" : "#45624f";
  const detail = isWhite ? "#7f6550" : "#6f8d76";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <defs>
      <linearGradient id="face" x1="0" y1="0" x2=".8" y2="1">
        <stop stop-color="${highlight}"/><stop offset=".52" stop-color="${fill}"/><stop offset="1" stop-color="${isWhite ? "#dfcfb3" : "#17291f"}"/>
      </linearGradient>
    </defs>
    <g fill="url(#face)" stroke="${stroke}" stroke-width="2.35" stroke-linejoin="round" stroke-linecap="round" paint-order="stroke fill">${body(code[1])}</g>
    <g fill="none" stroke="${detail}" stroke-opacity=".72" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round">${details(code[1])}</g>
  </svg>\n`;
}

const codes = [];
for (const color of ["w", "b"])
  for (const kind of ["P", "N", "B", "R", "Q", "K"]) codes.push(color + kind);
for (const code of codes) writeFileSync(join(TEX, "pieces", `${code}.svg`), pieceSvg(code));

console.log(`Generados: board, marcadores y ${codes.length} piezas Club Cinemático en ${TEX}`);
