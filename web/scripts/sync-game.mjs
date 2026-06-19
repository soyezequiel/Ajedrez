// Copia el build WASM del juego (game/bin/) a web/public/game/ para que el
// iframe del shell lo cargue same-origin (bajo COOP/COEP de Vite).
import { cpSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "game", "bin");
const dst = join(here, "..", "public", "game");

if (!existsSync(src) || readdirSync(src).length === 0) {
  console.warn("[sync-game] game/bin vacío — compilá el juego Vexel primero (ritual web / nim c -d:emscripten).");
  process.exit(0);
}
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log("[sync-game] copiado", src, "→", dst);
