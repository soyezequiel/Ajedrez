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

await render(join(TEX, "board.svg"), join(TEX, "board.png"), 1024);

const dir = join(TEX, "pieces");
for (const f of readdirSync(dir).filter((f) => f.endsWith(".svg"))) {
  await render(join(dir, f), join(dir, f.replace(".svg", ".png")), 256);
}
console.log("listo");
