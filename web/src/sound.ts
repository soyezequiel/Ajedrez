/**
 * Sonidos del juego sintetizados con Web Audio (sin assets externos). Tonos
 * cortos estilo chess.com: mover, capturar, jaque, inicio y fin de partida.
 * El AudioContext se desbloquea con el primer gesto del usuario (requisito de
 * autoplay de los navegadores) y el mute persiste en localStorage.
 */

export type SoundName =
  | "pickup"
  | "move"
  | "capture"
  | "check"
  | "invalid"
  | "ui"
  | "invite"
  | "start"
  | "time-low"
  | "time-critical"
  | "win"
  | "lose"
  | "end";

const SOUND_KEY = "ajedrez.sound.v1";
const HAPTICS_KEY = "ajedrez.haptics.v1";

let ctx: AudioContext | null = null;
let enabled = readEnabled();
let haptics = readHaptics();

function readEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

function readHaptics(): boolean {
  try { return localStorage.getItem(HAPTICS_KEY) !== "off"; }
  catch { return true; }
}

export function soundEnabled(): boolean {
  return enabled;
}

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(SOUND_KEY, on ? "on" : "off");
  } catch {
    /* storage bloqueado */
  }
}

export function hapticsEnabled(): boolean { return haptics; }

export function setHapticsEnabled(on: boolean): void {
  haptics = on;
  try { localStorage.setItem(HAPTICS_KEY, on ? "on" : "off"); }
  catch { /* storage bloqueado */ }
}

/** Crea/reanuda el contexto. Solo prospera tras un gesto del usuario. */
function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx.state === "running" ? ctx : ctx; // resume es async; el play igual encola
  } catch {
    return null;
  }
}

// Desbloqueo temprano: el primer gesto de la página habilita el audio para que
// el primer sonido "de verdad" (que puede venir de un evento de red) suene.
for (const ev of ["pointerdown", "keydown"] as const)
  document.addEventListener(ev, () => void audio(), { once: true });

interface Note {
  /** Frecuencia en Hz. */
  f: number;
  /** Offset de inicio en segundos. */
  at: number;
  /** Duración en segundos. */
  d: number;
  /** Volumen pico (0..1). */
  v?: number;
  type?: OscillatorType;
}

function play(notes: Note[]): void {
  if (!enabled) return;
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  for (const n of notes) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = n.type ?? "sine";
    osc.frequency.value = n.f;
    const t0 = now + n.at;
    const v = n.v ?? 0.18;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(v, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0004, t0 + n.d);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + n.d + 0.02);
  }
}

const SOUNDS: Record<SoundName, Note[]> = {
  pickup: [
    { f: 420, at: 0, d: 0.045, type: "triangle", v: 0.08 },
    { f: 160, at: 0, d: 0.055, type: "sine", v: 0.055 },
  ],
  // Golpecito seco de pieza sobre el tablero.
  move: [{ f: 260, at: 0, d: 0.09, type: "triangle", v: 0.22 }],
  // Captura: golpe más grave con un armónico corto.
  capture: [
    { f: 190, at: 0, d: 0.11, type: "triangle", v: 0.26 },
    { f: 95, at: 0, d: 0.13, type: "sine", v: 0.2 },
  ],
  // Jaque: dos notas de alerta ascendentes.
  check: [
    { f: 540, at: 0, d: 0.1, v: 0.14 },
    { f: 720, at: 0.11, d: 0.16, v: 0.14 },
  ],
  invalid: [
    { f: 150, at: 0, d: 0.08, type: "square", v: 0.08 },
    { f: 118, at: 0.07, d: 0.1, type: "triangle", v: 0.1 },
  ],
  ui: [{ f: 460, at: 0, d: 0.055, type: "sine", v: 0.07 }],
  invite: [
    { f: 494, at: 0, d: 0.1, v: 0.08 },
    { f: 659, at: 0.08, d: 0.18, v: 0.09 },
  ],
  // Inicio: arpegio breve y amable.
  start: [
    { f: 392, at: 0, d: 0.14, v: 0.12 },
    { f: 494, at: 0.09, d: 0.14, v: 0.12 },
    { f: 587, at: 0.18, d: 0.22, v: 0.12 },
  ],
  // Avisos del reloj: distinguibles del jaque y de una jugada.
  "time-low": [
    { f: 440, at: 0, d: 0.11, type: "triangle", v: 0.12 },
    { f: 440, at: 0.18, d: 0.14, type: "triangle", v: 0.12 },
  ],
  "time-critical": [
    { f: 660, at: 0, d: 0.08, type: "square", v: 0.1 },
    { f: 660, at: 0.13, d: 0.08, type: "square", v: 0.1 },
    { f: 880, at: 0.26, d: 0.17, type: "triangle", v: 0.12 },
  ],
  // Fin: resolución descendente.
  end: [
    { f: 587, at: 0, d: 0.16, v: 0.14 },
    { f: 494, at: 0.13, d: 0.16, v: 0.13 },
    { f: 392, at: 0.26, d: 0.3, v: 0.13 },
  ],
  win: [
    { f: 392, at: 0, d: 0.18, type: "triangle", v: 0.12 },
    { f: 494, at: 0.1, d: 0.22, type: "triangle", v: 0.12 },
    { f: 587, at: 0.2, d: 0.26, type: "triangle", v: 0.13 },
    { f: 784, at: 0.32, d: 0.48, type: "sine", v: 0.11 },
  ],
  lose: [
    { f: 294, at: 0, d: 0.2, type: "triangle", v: 0.1 },
    { f: 247, at: 0.14, d: 0.26, type: "triangle", v: 0.09 },
    { f: 196, at: 0.3, d: 0.4, type: "sine", v: 0.08 },
  ],
};

export function playSound(name: SoundName): void {
  play(SOUNDS[name]);
}

const VIBRATIONS: Partial<Record<SoundName, number | number[]>> = {
  pickup: 7,
  move: 10,
  capture: [12, 18, 20],
  check: [18, 35, 18],
  invalid: [18, 35, 18],
  invite: [10, 35, 12],
  "time-low": [20, 45, 20],
  "time-critical": [30, 35, 30, 35, 45],
  win: [15, 35, 20, 45, 28],
};

export function playFeedback(name: SoundName): void {
  playSound(name);
  const pattern = VIBRATIONS[name];
  if (!haptics || pattern === undefined || !("vibrate" in navigator)) return;
  try { navigator.vibrate(pattern); } catch { /* no soportado */ }
}
