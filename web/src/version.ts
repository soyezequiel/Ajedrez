// Auto-recarga la pestaña cuando el server anuncia un build nuevo (deploy), así
// nadie se queda mirando una versión vieja. Espeja el FreshGuard de Luna Negra.
//
// El build-id lo inyecta Vite en el index.html (window.__BUILD_ID__, lo fija el
// deploy vía env BUILD_ID) — NO dentro del bundle, así el hash del JS no cambia por
// deploy. El server reporta el suyo en GET /version. Si difieren, hubo un deploy
// nuevo → avisamos y recargamos. En dev queda "" y no hacemos nada.

declare global {
  interface Window {
    __BUILD_ID__?: string;
  }
}

const OWN = String(window.__BUILD_ID__ ?? "").trim();
const POLL_MS = 60_000;

export function startVersionGuard(notify?: (msg: string) => void): void {
  if (!OWN) return; // dev (sin build id)

  let reloading = false;
  const reload = () => {
    if (reloading) return;
    reloading = true;
    notify?.("Nueva versión — actualizando…");
    // Pausa breve para que se vea el aviso antes de recargar.
    setTimeout(() => location.reload(), 1200);
  };

  const check = async () => {
    if (document.visibilityState !== "visible" || reloading) return;
    try {
      const res = await fetch("/version", { cache: "no-store" });
      if (!res.ok) return;
      const { buildId } = (await res.json()) as { buildId?: string };
      const server = String(buildId ?? "").trim();
      if (server && server !== OWN) reload();
    } catch {
      // Sin red o server reiniciando (justo durante el deploy): reintenta al próximo tick.
    }
  };

  // bfcache: al volver atrás/adelante o reabrir una pestaña suspendida, el navegador
  // restaura un snapshot viejo que ignora los headers de no-cache → recargamos.
  window.addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) reload();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
  window.setInterval(() => void check(), POLL_MS);
  // Chequeo inicial (por si el index vino cacheado del borde con un bundle viejo).
  void check();
}
