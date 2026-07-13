// Actualiza únicamente el paquete de assets preloaded de Emscripten. Permite
// iterar arte sin relinkear el WASM cuando no está instalado emcc.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const jsPath = join(root, "bin", "ajedrez.js");
const dataPath = join(root, "bin", "ajedrez.data");
let js = readFileSync(jsPath, "utf8");

const callStart = js.indexOf("loadPackage({");
const newline = js.includes("\r\n") ? "\r\n" : "\n";
const packageTail = /\r?\n\s*\}\);\r?\n\}\)\(\);/g;
packageTail.lastIndex = Math.max(callStart, 0);
const tailMatch = packageTail.exec(js);
if (callStart < 0 || !tailMatch) throw new Error("No se encontró metadata de preload en ajedrez.js");

const jsonStart = callStart + "loadPackage(".length;
const closingBrace = js.indexOf("}", tailMatch.index);
const jsonEnd = closingBrace + 1;
const metadata = JSON.parse(js.slice(jsonStart, jsonEnd));
const chunks = [];
let offset = 0;
for (const file of metadata.files) {
  const relative = file.filename.replace(/^\//, "");
  const bytes = readFileSync(join(root, relative));
  file.start = offset;
  offset += bytes.length;
  file.end = offset;
  chunks.push(bytes);
}
metadata.remote_package_size = offset;

const formatted = JSON.stringify(metadata, null, 2).split("\n").map((line, index) => index ? `  ${line}` : line).join("\n");
const replacement = `  loadPackage(${formatted});`;
const callEnd = closingBrace + 3;
const indentStart = js.lastIndexOf(newline, callStart) + newline.length;
js = js.slice(0, indentStart) + replacement + js.slice(callEnd);
writeFileSync(dataPath, Buffer.concat(chunks));
writeFileSync(jsPath, js);
console.log(`Reempaquetados ${metadata.files.length} assets (${offset} bytes)`);
