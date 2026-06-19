// URL del WebSocket del servidor de ajedrez. Override con VITE_WS_URL.
export const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8787";
// Base de Luna Negra (para el leaderboard "Top", §6). Override con VITE_LUNA_URL.
export const LUNA_URL = import.meta.env.VITE_LUNA_URL ??
    "https://luna-negra-three.vercel.app";
export const LEADERBOARD = "ajedrez";
