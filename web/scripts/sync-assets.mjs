// Copia los assets generados en game/textures/ a web/public/textures/.
// La fuente de verdad es game/textures (ver game/tools/gen-assets.mjs).
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "game", "textures");
const dst = join(here, "..", "public", "textures");

if (!existsSync(src)) {
  console.warn("[sync-assets] no existe", src, "— generá los assets primero");
  process.exit(0);
}
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log("[sync-assets] copiado", src, "→", dst);
