// ============================================================================
// MODO DE PRUEBA de integraciones NGP — panel de diagnóstico (`?ngptest=1`).
//
// Dispara con un click cada integración observable por Luna Negra y reporta el
// resultado inline (event id + relays que aceptaron). Aislado a propósito: TODO
// el modo vive acá. Para SACARLO: borrar este archivo y las ~3 líneas de gancho
// en main.ts (import + `if (isNgpTestMode()) mountDiagPanel(net)`).
//
// Qué dispara y quién firma:
//   - Presencia NIP-38 (30315), Marcador (31339), Reseña (kind:1): el signer del
//     panel (login Nostr activo, o una clave de test generada al vuelo).
//   - Marcador verificado (31338): lo firma el ORÁCULO en el server (WS test_attest);
//     el panel lo publica. Requiere login Nostr real.
//   - Zap (recibo 9735): se genera un invoice; lo pagás vos con tu billetera.
//   - Apuesta NGE: solo guía al flujo real de 2 jugadores (no se fuerza en solitario).
// ============================================================================

import { buildPresenceEvent, buildScoreEvent } from "nostr-game-protocol/ngp";
import type { NgpSigner } from "nostr-game-protocol/ngp";
import { npubEncode } from "nostr-tools/nip19";
import type { Event } from "nostr-tools";
import { GAME_COORD, PRESENCE_MESSAGE, RELAYS, SCORE_BOARD } from "../config.js";
import { getPool } from "./relays.js";
import { createZapInvoice } from "./zap.js";
import { toPubkeyHex } from "./challenge.js";
import { generateLocalSigner, toNgpSigner } from "./signer-core.js";
import type { Net } from "../net.js";

/** ¿Está activo el modo de prueba? Flag de URL, no toca el flujo normal. */
export function isNgpTestMode(): boolean {
  return new URLSearchParams(location.search).get("ngptest") === "1";
}

/** Sesión de la app que el panel lee (la maneja main.ts vía `login`). `mode` null
 *  = todavía arrancando; "guest" = login por nombre (sin Nostr); "nostr" = firmante. */
export interface AppSession {
  mode: "nostr" | "guest" | null;
  signer: NgpSigner | null;
}

interface PanelSigner {
  ngp: NgpSigner;
  pubkey: string;
  /** true si es una clave de test generada acá (no el login real). */
  ephemeral: boolean;
}

/** Publica a los relays de escritura y REPORTA cuántos aceptaron (a diferencia de
 *  publishToWrite, que traga todo). */
async function publishReport(event: Event): Promise<{ id: string; ok: number; total: number }> {
  const results = await Promise.allSettled(getPool().publish([...RELAYS.write], event));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  return { id: event.id, ok, total: results.length };
}

/** njump para inspeccionar el evento en un explorador Nostr. */
function njump(id: string): string {
  return `https://njump.me/${id}`;
}

function short(hex: string): string {
  try {
    const np = npubEncode(hex);
    return `${np.slice(0, 12)}…${np.slice(-4)}`;
  } catch {
    return `${hex.slice(0, 8)}…`;
  }
}

// --------------------------------------------------------------- panel

export function mountDiagPanel(net: Net, getSession?: () => AppSession): void {
  if (document.getElementById("ngp-diag")) return;

  // El server responde el marcador verificado por SU canal (test_attestation),
  // con el evento o con el motivo del error. NO tocamos el handler de "error" de
  // la app (Net guarda uno solo por evento: registrarlo acá lo pisaría).
  let attestPending: ((r: AttestReply) => void) | null = null;
  net.on("test_attestation", (m) => {
    const cb = attestPending;
    attestPending = null;
    cb?.({ event: (m.event as unknown as Event) ?? null, error: m.error });
  });

  // Clave de test opcional: solo si la usás como override (botón "Generar clave").
  let ephemeral: PanelSigner | null = null;
  // pubkey de tu sesión Nostr, resuelta async (solo para el display).
  let sessionPubkey = "";
  const storePubkey = GAME_COORD.split(":")[1] ?? "";

  /** Firmante que usan los botones: tu sesión Nostr por defecto; clave de test si la generaste. */
  function currentSigner(): PanelSigner | null {
    if (ephemeral) return ephemeral;
    const s = getSession?.();
    if (s?.mode === "nostr" && s.signer)
      return { ngp: s.signer, pubkey: sessionPubkey, ephemeral: false };
    return null;
  }

  const el = document.createElement("div");
  el.id = "ngp-diag";
  el.innerHTML = panelHtml(storePubkey);
  document.body.appendChild(el);
  injectStyles();

  const $ = (id: string) => el.querySelector<HTMLElement>(`#${id}`);

  function refreshWho(): void {
    const who = $("diag-who");
    if (who) who.innerHTML = whoHtml(currentSigner(), getSession?.() ?? { mode: null, signer: null });
  }

  /** Espera a que la app termine de restaurar la sesión Nostr y muestra tu npub. */
  async function resolveSessionPubkey(): Promise<void> {
    for (let i = 0; i < 30 && !ephemeral; i++) {
      const s = getSession?.();
      if (s?.mode === "nostr" && s.signer) {
        try {
          sessionPubkey = await s.signer.getPublicKey();
          refreshWho();
        } catch {
          /* la extensión/bunker no respondió: se reintenta abajo */
        }
        if (sessionPubkey) return;
      } else if (s?.mode === "guest") {
        refreshWho();
        return; // invitado: no hay sesión Nostr que esperar
      }
      refreshWho();
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  void resolveSessionPubkey();

  $("diag-close")?.addEventListener("click", () => el.remove());

  $("diag-genkey")?.addEventListener("click", () => {
    const { signer: s, nsec } = generateLocalSigner();
    void s.getPublicKey().then((pk) => {
      ephemeral = { ngp: toNgpSigner(s), pubkey: pk, ephemeral: true };
      refreshWho();
      toast(`Clave de test generada · guardala si querés: ${nsec.slice(0, 14)}…`);
    });
  });

  // --- Presencia (30315) ---
  $("row-presence-btn")?.addEventListener("click", () => {
    runRow("row-presence", async () => {
      const s = need(currentSigner());
      const ev = await buildPresenceEvent(s.ngp, {
        gameCoord: GAME_COORD,
        message: PRESENCE_MESSAGE,
        ttlSec: 240,
      });
      return publishReport(ev as unknown as Event);
    });
  });

  // --- Marcador (31339) ---
  $("row-score-btn")?.addEventListener("click", () => {
    runRow("row-score", async () => {
      const s = need(currentSigner());
      const rating = 1000 + Math.floor(Number(($("row-score-val") as HTMLInputElement)?.value) || 200);
      const ev = await buildScoreEvent(s.ngp, {
        gameCoord: GAME_COORD,
        board: SCORE_BOARD,
        score: rating,
        client: "ajedrez-web-diag",
      });
      return publishReport(ev as unknown as Event);
    });
  });

  // --- Reseña / logro (kind:1) ---
  $("row-note-btn")?.addEventListener("click", () => {
    runRow("row-note", async () => {
      const s = need(currentSigner());
      const content = ($("row-note-val") as HTMLTextAreaElement)?.value?.trim() || "Probando el ajedrez de Luna Negra ♟ #ngp";
      const ev = await s.ngp.signEvent({
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["a", GAME_COORD]],
        content,
      });
      return publishReport(ev as unknown as Event);
    });
  });

  // --- Marcador verificado (31338, oráculo server-side) ---
  $("row-verified-btn")?.addEventListener("click", () => {
    runRow("row-verified", async () => {
      const s = need(currentSigner());
      if (s.ephemeral)
        throw new Error("El marcador verificado usa tu pubkey de sesión: entrá con Nostr (no con clave de test)");
      const rating = 1000 + Math.floor(Number(($("row-score-val") as HTMLInputElement)?.value) || 200);
      const reply = await requestAttestation(net, rating, (cb) => (attestPending = cb));
      if (!reply)
        throw new Error(
          "El server no respondió en 8s — ¿está corriendo, tiene el código nuevo y estás logueado con Nostr?",
        );
      if (!reply.event) throw new Error(reply.error || "El server no pudo firmar la atestación");
      return publishReport(reply.event);
    });
  });

  // --- Zap real (NIP-57) ---
  $("row-zap-btn")?.addEventListener("click", () => {
    runRow("row-zap", async () => {
      const s = need(currentSigner());
      const target = (($("row-zap-target") as HTMLInputElement)?.value || "").trim();
      const recipient = target ? toPubkeyHexLoose(target) : storePubkey;
      if (!recipient) throw new Error("No hay receptor válido para el zap");
      const inv = await createZapInvoice(s.ngp, recipient, 4, "Prueba de zap · ajedrez NGP");
      showZapInvoice(inv.bolt11, inv.amountSats);
      return { id: "", ok: 1, total: 1, note: `invoice de ${inv.amountSats} sats generado — pagalo con tu billetera` };
    });
  });

  function setStatus(rowId: string, text: string, kind: "ok" | "err" | "run"): void {
    const s = el.querySelector<HTMLElement>(`#${rowId} .diag-status`);
    if (s) {
      s.textContent = text;
      s.dataset.kind = kind;
    }
  }

  async function runRow(
    rowId: string,
    fn: () => Promise<{ id: string; ok: number; total: number; note?: string }>,
  ): Promise<void> {
    const btn = el.querySelector<HTMLButtonElement>(`#${rowId} button`);
    if (btn) btn.disabled = true;
    setStatus(rowId, "Publicando…", "run");
    try {
      const r = await fn();
      const link = r.id ? ` · <a href="${njump(r.id)}" target="_blank" rel="noreferrer">${r.id.slice(0, 10)}…</a>` : "";
      const msg = r.note ?? `publicado en ${r.ok}/${r.total} relays`;
      const s = el.querySelector<HTMLElement>(`#${rowId} .diag-status`);
      if (s) {
        s.innerHTML = `${r.ok > 0 || r.note ? "✓" : "✗"} ${msg}${link}`;
        s.dataset.kind = r.ok > 0 || r.note ? "ok" : "err";
      }
    } catch (err) {
      setStatus(rowId, `✗ ${err instanceof Error ? err.message : String(err)}`, "err");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function showZapInvoice(bolt11: string, sats: number): void {
    const box = $("row-zap-invoice");
    if (!box) return;
    box.innerHTML = `
      <div class="diag-invoice-label">${sats} sats · pagá con tu billetera Lightning</div>
      <textarea class="diag-invoice" readonly rows="3">${bolt11}</textarea>
      <div class="diag-invoice-actions">
        <a class="diag-btn" href="lightning:${bolt11}">Abrir en billetera</a>
        <button class="diag-btn" id="row-zap-copy" type="button">Copiar</button>
      </div>`;
    box.querySelector("#row-zap-copy")?.addEventListener("click", () =>
      navigator.clipboard.writeText(bolt11).then(() => toast("Invoice copiado")),
    );
  }
}

function need(s: PanelSigner | null): PanelSigner {
  if (!s) throw new Error("Entrá con Nostr (o generá una clave de test) primero");
  return s;
}

/** Respuesta del server al pedido de atestación: el evento firmado, o el motivo. */
interface AttestReply {
  event: Event | null;
  error?: string;
}

/** Pide al server (oráculo) firmar la atestación y espera la respuesta por WS.
 *  Devuelve null si no llegó nada en 8s (server caído / viejo / no autenticado). */
function requestAttestation(
  net: Net,
  score: number,
  setPending: (cb: (r: AttestReply) => void) => void,
): Promise<AttestReply | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000);
    setPending((r) => {
      clearTimeout(timer);
      resolve(r);
    });
    net.send({ t: "test_attest", score });
  });
}

/** npub/hex → hex laxo (para el input de receptor del zap). Vacío si no parsea. */
function toPubkeyHexLoose(input: string): string {
  try {
    return toPubkeyHex(input);
  } catch {
    return "";
  }
}

// --------------------------------------------------------------- render

function whoHtml(s: PanelSigner | null, session: AppSession): string {
  if (s) {
    const label = s.pubkey ? short(s.pubkey) : "…";
    return `Firmando como <b>${label}</b>${s.ephemeral ? ' <span class="diag-warn">(clave de test)</span>' : ""}`;
  }
  if (session.mode === "nostr")
    return `<span class="diag-warn">Restaurando tu sesión Nostr…</span>`;
  if (session.mode === "guest")
    return `<span class="diag-warn">Estás como invitado</span> — el modo NGP necesita Nostr: entrá con Nostr o generá una clave de test`;
  return `<span class="diag-warn">Iniciando…</span> — esperando tu sesión Nostr`;
}

function row(id: string, kind: string, title: string, desc: string, btn: string, extra = ""): string {
  return `
    <div class="diag-row" id="${id}">
      <div class="diag-row-main">
        <div class="diag-row-title"><span class="diag-kind">${kind}</span> ${title}</div>
        <div class="diag-row-desc">${desc}</div>
        ${extra}
        <div class="diag-status" data-kind="idle">—</div>
      </div>
      <button id="${id}-btn" type="button">${btn}</button>
    </div>`;
}

function panelHtml(storePubkey: string): string {
  return `
    <div class="diag-card">
      <div class="diag-head">
        <div>
          <div class="diag-title">🧪 Modo de prueba NGP</div>
          <div class="diag-who" id="diag-who">${whoHtml(null, { mode: null, signer: null })}</div>
        </div>
        <div class="diag-head-actions">
          <button id="diag-genkey" type="button">Generar clave de test</button>
          <button id="diag-close" type="button" aria-label="Cerrar">✕</button>
        </div>
      </div>

      ${row("row-presence", "NIP-38", "Presencia", "Firma kind:30315 “Jugando Ajedrez” anclado al juego.", "Disparar")}
      ${row(
        "row-score",
        "kind:31339",
        "Marcador",
        "Firma tu rating y lo publica al ranking social.",
        "Disparar",
        `<label class="diag-inline">rating base +<input id="row-score-val" type="number" value="200" min="1" max="800" /></label>`,
      )}
      ${row(
        "row-note",
        "kind:1",
        "Reseña / logro",
        "Nota kind:1 anclada al juego (la que figura “sin uso reciente”).",
        "Disparar",
        `<textarea id="row-note-val" rows="2" placeholder="Probando el ajedrez de Luna Negra ♟ #ngp"></textarea>`,
      )}
      ${row(
        "row-verified",
        "kind:31338",
        "Marcador verificado",
        "El <b>oráculo del server</b> firma la atestación (requiere login Nostr + NGP_ATTESTATION_ORACLE_NSEC). El panel la publica.",
        "Disparar",
      )}
      ${row(
        "row-zap",
        "NIP-57",
        "Zap real (4 sats)",
        "Genera un invoice; lo pagás vos con tu billetera y el recibo kind:9735 queda en relays.",
        "Generar invoice",
        `<label class="diag-inline">a <input id="row-zap-target" type="text" placeholder="npub del receptor (default: tienda)" /></label>
         <div id="row-zap-invoice"></div>
         <div class="diag-hint">Default: la tienda <code>${short(storePubkey)}</code> (necesita lud16 en su perfil).</div>`,
      )}

      <div class="diag-row diag-manual">
        <div class="diag-row-main">
          <div class="diag-row-title"><span class="diag-kind">NGE</span> Apuesta con escrow</div>
          <div class="diag-row-desc">
            La apuesta usa el escrow real de Luna Negra y necesita <b>2 jugadores Nostr</b>.
            Abrí una sala, invitá un rival (u otra pestaña con otra cuenta Nostr) y, de anfitrión,
            proponé <b>4 sats</b>. Ambos pagan su invoice y arranca. (Solo si el server tiene
            <code>NGE_CONNECTION</code>.)
          </div>
          <div class="diag-status" data-kind="idle">flujo de 2 jugadores</div>
        </div>
        <button id="diag-goroom" type="button" onclick="location.href='/'">Ir al home</button>
      </div>

      <div class="diag-foot">Sacá este panel borrando <code>web/src/nostr/diag.ts</code> y su gancho en main.ts.</div>
    </div>`;
}

// --------------------------------------------------------------- estilos (inline, removibles)

function injectStyles(): void {
  if (document.getElementById("ngp-diag-styles")) return;
  const style = document.createElement("style");
  style.id = "ngp-diag-styles";
  style.textContent = `
  #ngp-diag{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-start;justify-content:center;
    background:rgba(6,10,20,.72);overflow:auto;padding:24px;font-family:'IBM Plex Sans',system-ui,sans-serif}
  #ngp-diag .diag-card{width:min(640px,100%);background:#0e1526;color:#e7ecf6;border:1px solid #26324d;
    border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden}
  #ngp-diag .diag-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;
    padding:16px 18px;background:linear-gradient(180deg,#131c33,#0e1526);border-bottom:1px solid #26324d}
  #ngp-diag .diag-title{font-weight:700;font-size:16px}
  #ngp-diag .diag-who{font-size:12.5px;color:#9fb0cc;margin-top:3px}
  #ngp-diag .diag-who b{color:#c9a45c}
  #ngp-diag .diag-warn{color:#e0a23c}
  #ngp-diag .diag-head-actions{display:flex;gap:8px;flex-shrink:0}
  #ngp-diag .diag-row{display:flex;gap:12px;align-items:flex-start;justify-content:space-between;
    padding:14px 18px;border-bottom:1px solid #1b2438}
  #ngp-diag .diag-row-main{flex:1;min-width:0}
  #ngp-diag .diag-row-title{font-weight:600;font-size:14px}
  #ngp-diag .diag-kind{font:600 10.5px/1.6 'IBM Plex Mono',monospace;color:#7fd1c0;background:#12211e;
    border:1px solid #1e3a34;border-radius:5px;padding:1px 6px;margin-right:6px;vertical-align:middle}
  #ngp-diag .diag-row-desc{font-size:12.5px;color:#9fb0cc;margin-top:4px}
  #ngp-diag .diag-hint{font-size:11.5px;color:#7f8ea8;margin-top:5px}
  #ngp-diag code{font-family:'IBM Plex Mono',monospace;background:#0a1120;border:1px solid #23304a;
    border-radius:4px;padding:0 4px;font-size:11.5px}
  #ngp-diag .diag-status{font-size:12px;margin-top:7px;color:#8ba0c0;word-break:break-word}
  #ngp-diag .diag-status[data-kind=ok]{color:#67d090}
  #ngp-diag .diag-status[data-kind=err]{color:#f08a8a}
  #ngp-diag .diag-status[data-kind=run]{color:#e0c05c}
  #ngp-diag .diag-status a{color:#8fbcff}
  #ngp-diag .diag-inline{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#9fb0cc;margin-top:6px}
  #ngp-diag input,#ngp-diag textarea{background:#0a1120;border:1px solid #26324d;border-radius:7px;
    color:#e7ecf6;padding:6px 8px;font:inherit;font-size:12.5px}
  #ngp-diag input[type=number]{width:64px}
  #ngp-diag #row-zap-target{width:min(280px,60%)}
  #ngp-diag textarea{display:block;width:100%;margin-top:6px;resize:vertical}
  #ngp-diag button{background:#c9a45c;color:#0e1526;border:0;border-radius:8px;padding:8px 14px;
    font:600 13px/1 'IBM Plex Sans',sans-serif;cursor:pointer;flex-shrink:0}
  #ngp-diag button:hover{filter:brightness(1.06)}
  #ngp-diag button:disabled{opacity:.5;cursor:default}
  #ngp-diag #diag-close{background:#1b2438;color:#c9d3e6;padding:8px 11px}
  #ngp-diag #diag-genkey{background:#1b2438;color:#c9d3e6}
  #ngp-diag .diag-btn{background:#1b2438;color:#c9d3e6;text-decoration:none;display:inline-block}
  #ngp-diag .diag-invoice{width:100%;margin-top:8px;font-family:'IBM Plex Mono',monospace;font-size:11px}
  #ngp-diag .diag-invoice-label{font-size:12px;color:#c9a45c;margin-top:8px}
  #ngp-diag .diag-invoice-actions{display:flex;gap:8px;margin-top:6px}
  #ngp-diag .diag-manual{background:#0b1220}
  #ngp-diag .diag-foot{padding:12px 18px;font-size:11.5px;color:#6f7f9c}
  #ngp-diag .toast{position:fixed}
  `;
  document.head.appendChild(style);
}

function toast(text: string): void {
  const t = document.createElement("div");
  t.textContent = text;
  t.style.cssText =
    "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:10000;background:#131c33;" +
    "color:#e7ecf6;border:1px solid #26324d;border-radius:8px;padding:10px 16px;font:13px 'IBM Plex Sans',sans-serif;" +
    "box-shadow:0 10px 30px rgba(0,0,0,.5)";
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
