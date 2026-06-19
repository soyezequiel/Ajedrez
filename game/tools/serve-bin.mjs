// Sirve game/bin/ con los headers COOP/COEP que emscripten necesita para
// -pthread (SharedArrayBuffer). Uso: node tools/serve-bin.mjs [puerto]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
const port = Number(process.argv[2] ?? 8090);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".png": "image/png",
};

createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  const path = join(root, url === "/" ? "ajedrez.html" : decodeURIComponent(url));
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  try {
    const body = await readFile(path);
    res.setHeader("Content-Type", types[extname(path)] ?? "application/octet-stream");
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
}).listen(port, () => console.log(`game/bin servido en http://localhost:${port}`));
