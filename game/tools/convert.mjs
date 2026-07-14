// Rasteriza los SVG de textures/ a PNG con sharp.
//   cd tools && npm i && node convert.mjs
import sharp from "sharp";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEX = join(dirname(fileURLToPath(import.meta.url)), "..", "textures");

async function render(svgPath, pngPath, size) {
  const svg = readFileSync(svgPath);
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(pngPath);
  console.log("→", pngPath);
}

async function renderRect(svgPath, pngPath, width, height) {
  const svg = readFileSync(svgPath);
  await sharp(svg, { density: 384 }).resize(width, height).png().toFile(pngPath);
  console.log("→", pngPath);
}

await render(join(TEX, "board.svg"), join(TEX, "board.png"), 1024);
await render(join(TEX, "highlight.svg"), join(TEX, "highlight.png"), 64);
await render(join(TEX, "select.svg"), join(TEX, "select.png"), 64);

for (const name of ["legal", "capture", "ring", "spark", "veil"]) {
  const size = name === "spark" ? 32 : 128;
  await render(join(TEX, "effects", `${name}.svg`), join(TEX, "effects", `${name}.png`), size);
}
await renderRect(join(TEX, "effects", "trail.svg"), join(TEX, "effects", "trail.png"), 128, 16);

for (const side of ["white", "black"]) {
  await render(join(TEX, "coordinates", `${side}.svg`), join(TEX, "coordinates", `${side}.png`), 600);
}
for (const name of ["3", "2", "1", "go"]) {
  await render(join(TEX, "countdown", `${name}.svg`), join(TEX, "countdown", `${name}.png`), 256);
}

const dir = join(TEX, "pieces");
for (const f of readdirSync(dir).filter((f) => f.endsWith(".svg"))) {
  // 512 px conserva bordes limpios en pantallas retina y durante el zoom/drag.
  await render(join(dir, f), join(dir, f.replace(".svg", ".png")), 512);
}
console.log("listo");
