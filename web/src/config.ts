// URL del WebSocket del servidor de ajedrez.
//   - Deploy unificado (el server sirve este web): se deriva del origen actual,
//     así funciona en localhost y en LAN (con la IP del host) sin reconfigurar.
//   - Dev con Vite en :5173 (server aparte en :8787): se fija con VITE_WS_URL
//     (ver web/.env.development).
function sameOriginWs(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

export const WS_URL =
  (import.meta.env.VITE_WS_URL as string | undefined) ?? sameOriginWs();
