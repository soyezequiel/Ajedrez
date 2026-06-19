// Smoke test de la integración con Luna Negra (M0).
//
// Confirma, sin necesidad de un jugador real, que:
//   1. El deploy de Luna Negra responde (openapi alcanzable).
//   2. Las credenciales server-to-server están completas (API key + gameId).
//   3. La API key funciona de verdad: GET /api/v1/provider/webhook (server-only).
//   4. El webhook está configurado y su secret coincide con server/.env.
//
// Correr DESPUÉS de pegar las credenciales reales en server/.env:
//   cd server && npm run verify:luna
//
// La API key (ln_sk_…) vive solo acá; este script nunca la imprime.

try {
  process.loadEnvFile();
} catch {
  // sin .env: usamos lo que haya en el entorno
}

const baseUrl = (process.env.LUNA_BASE_URL ?? "https://luna-negra-three.vercel.app").replace(/\/$/, "");
const apiKey = process.env.LUNA_API_KEY ?? "";
const gameId = process.env.LUNA_GAME_ID ?? "";
const webhookSecret = process.env.LUNA_WEBHOOK_SECRET ?? "";

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`  \x1b[2m·\x1b[0m ${m}`);

let failed = false;
const fail = (m) => {
  bad(m);
  failed = true;
};

console.log(`\nVerificando Luna Negra en ${baseUrl}\n`);

// 1) Deploy alcanzable
try {
  const r = await fetch(`${baseUrl}/openapi.json`);
  if (r.ok) ok(`deploy alcanzable (openapi ${r.status})`);
  else fail(`openapi respondió ${r.status}`);
} catch (e) {
  fail(`no se pudo alcanzar el deploy: ${e.message}`);
}

// 2) Credenciales presentes
const live = Boolean(apiKey && gameId);
if (!live) {
  console.log("");
  info("Modo MOCK: faltan LUNA_API_KEY y/o LUNA_GAME_ID en server/.env.");
  info("Crealas en " + baseUrl + "/provider y pegalas en server/.env, después");
  info("volvé a correr `npm run verify:luna`.");
  console.log("");
} else {
  ok("LUNA_API_KEY y LUNA_GAME_ID presentes");

  // 3) La API key funciona (endpoint server-to-server) + 4) webhook
  try {
    const r = await fetch(`${baseUrl}/api/v1/provider/webhook`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (r.status === 401 || r.status === 403) {
      fail(`la API key fue rechazada (${r.status}) — revisá LUNA_API_KEY`);
    } else if (!r.ok) {
      fail(`/provider/webhook respondió ${r.status}`);
    } else {
      ok("API key válida (server-to-server autenticado)");
      const cfg = await r.json();
      if (cfg?.url) {
        ok(`webhook configurado → ${cfg.url}`);
        if (webhookSecret && cfg.secret && webhookSecret === cfg.secret) {
          ok("LUNA_WEBHOOK_SECRET coincide con el de Luna Negra");
        } else if (webhookSecret) {
          fail("LUNA_WEBHOOK_SECRET no coincide con el secret remoto");
        } else {
          info("LUNA_WEBHOOK_SECRET vacío: copialo desde la respuesta del provider");
        }
      } else {
        info("webhook aún sin configurar (opcional para M0; necesario para apuestas)");
      }
    }
  } catch (e) {
    fail(`error consultando /provider/webhook: ${e.message}`);
  }

  console.log("");
  if (failed) console.log("\x1b[31mResultado: hay problemas que resolver.\x1b[0m\n");
  else console.log("\x1b[32mResultado: LIVE — credenciales OK.\x1b[0m\n");
}

// `process.exitCode` (no `process.exit()`): evita el assert de libuv en Windows
// cuando quedan sockets keepalive de fetch abiertos al salir.
process.exitCode = failed ? 1 : 0;
