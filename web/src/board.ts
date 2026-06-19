import type { Color } from "./protocol.js";

export type MoveFn = (from: string, to: string, promo: string) => void;

// Contrato común a los dos motores de tablero: el canvas interino y el de Vexel.
// Ambos exponen applyFen/setInteractive/highlight y emiten jugadas por onMove.
export interface BoardController {
  applyFen(fen: string): void;
  setInteractive(on: boolean): void;
  setOrientation(color: Color): void;
  highlight(squares: string[]): void;
  destroy(): void;
}

const PIECE_CODES = ["wP", "wN", "wB", "wR", "wQ", "wK", "bP", "bN", "bB", "bR", "bQ", "bK"];
const SELECT_FILL = "rgba(255, 213, 79, 0.55)";
const HINT_FILL = "rgba(60, 64, 72, 0.30)";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("no cargó " + src));
    img.src = src;
  });
}

/** Tablero 2D en <canvas> usando los PNG de game/textures. */
export class CanvasBoard implements BoardController {
  private readonly ctx: CanvasRenderingContext2D;
  private board: HTMLImageElement | null = null;
  private readonly pieces = new Map<string, HTMLImageElement>();
  private placement: (string | null)[] = new Array(64).fill(null);
  private orientation: Color = "w";
  private interactive = false;
  private selected: number | null = null;
  private highlighted: number[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onMove: MoveFn,
    base = "/textures",
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d no disponible");
    this.ctx = ctx;
    this.canvas.addEventListener("click", (e) => this.onClick(e));
    void this.load(base).then(() => this.draw());
  }

  private async load(base: string): Promise<void> {
    this.board = await loadImage(`${base}/board.png`);
    await Promise.all(
      PIECE_CODES.map(async (code) => {
        this.pieces.set(code, await loadImage(`${base}/pieces/${code}.png`));
      }),
    );
  }

  applyFen(fen: string): void {
    this.placement = new Array(64).fill(null);
    let i = 0;
    for (const ch of fen.split(" ")[0] ?? "") {
      if (ch === "/") continue;
      if (ch >= "1" && ch <= "8") {
        i += Number(ch);
      } else {
        const color = ch === ch.toUpperCase() ? "w" : "b";
        this.placement[i] = color + ch.toUpperCase();
        i += 1;
      }
    }
    this.selected = null;
    this.draw();
  }

  setInteractive(on: boolean): void {
    this.interactive = on;
    if (!on) this.selected = null;
    this.draw();
  }

  setOrientation(color: Color): void {
    this.orientation = color;
    this.draw();
  }

  highlight(squares: string[]): void {
    this.highlighted = squares.map(squareToIndex).filter((i) => i >= 0);
    this.draw();
  }

  destroy(): void {
    this.canvas.replaceWith(this.canvas.cloneNode(true));
  }

  /** index 0..63 (rank8a..rank1h) → posición de dibujo según orientación. */
  private cellRect(index: number): { x: number; y: number; size: number } {
    const size = this.canvas.clientWidth / 8;
    const file = index % 8;
    const rank = Math.floor(index / 8);
    const col = this.orientation === "w" ? file : 7 - file;
    const row = this.orientation === "w" ? rank : 7 - rank;
    return { x: col * size, y: row * size, size };
  }

  private draw(): void {
    const css = this.canvas.clientWidth || 480;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== css * dpr) {
      this.canvas.width = css * dpr;
      this.canvas.height = css * dpr;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, css, css);
    if (this.board) ctx.drawImage(this.board, 0, 0, css, css);

    for (const idx of this.highlighted) this.paintCell(idx, HINT_FILL);
    if (this.selected !== null) this.paintCell(this.selected, SELECT_FILL);

    for (let i = 0; i < 64; i++) {
      const code = this.placement[i];
      if (!code) continue;
      const img = this.pieces.get(code);
      if (!img) continue;
      const { x, y, size } = this.cellRect(i);
      ctx.drawImage(img, x, y, size, size);
    }
  }

  private paintCell(index: number, fill: string): void {
    const { x, y, size } = this.cellRect(index);
    this.ctx.fillStyle = fill;
    this.ctx.fillRect(x, y, size, size);
  }

  private onClick(e: MouseEvent): void {
    if (!this.interactive) return;
    const rect = this.canvas.getBoundingClientRect();
    const size = rect.width / 8;
    const col = Math.floor((e.clientX - rect.left) / size);
    const row = Math.floor((e.clientY - rect.top) / size);
    if (col < 0 || col > 7 || row < 0 || row > 7) return;
    const file = this.orientation === "w" ? col : 7 - col;
    const rank = this.orientation === "w" ? row : 7 - row;
    const index = rank * 8 + file;

    if (this.selected === null) {
      if (this.placement[index]) {
        this.selected = index;
        this.draw();
      }
    } else {
      const from = indexToSquare(this.selected);
      const to = indexToSquare(index);
      this.selected = null;
      this.draw();
      if (from !== to) this.onMove(from, to, "");
    }
  }
}

function indexToSquare(index: number): string {
  const file = index % 8;
  const rank = Math.floor(index / 8); // 0 = fila 8
  return String.fromCharCode(97 + file) + (8 - rank);
}

function squareToIndex(square: string): number {
  if (square.length < 2) return -1;
  const file = square.charCodeAt(0) - 97;
  const rank = 8 - Number(square[1]);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return -1;
  return rank * 8 + file;
}

const GAME_BASE = (import.meta.env.VITE_GAME_BASE as string | undefined) ?? "/game";

declare global {
  interface Window {
    Module?: {
      ccall?: (name: string, ret: string | null, types: string[], args: unknown[]) => unknown;
      [k: string]: unknown;
    };
    __chess?: { onMove: (from: string, to: string, promo: string) => void };
  }
}

/**
 * Tablero renderizado por Vexel (WASM/WebGPU) cargado EN LA MISMA PÁGINA (no en un
 * iframe). Motivo: un iframe deadlockea el `requestDevice` de WebGPU con los
 * pthreads de emscripten/Dawn; en contexto top-level resuelve igual que el build
 * standalone. Inyecta `game/bin/ajedrez.js` con `Module.canvas` + `locateFile` y
 * habla con el juego por `ccall`. Una sola instancia por carga de página (el botón
 * "volver al inicio" hace `location.reload()`).
 */
export class VexelBoard implements BoardController {
  private ready = false;
  private readonly queue: Array<() => void> = [];
  private readonly canvas: HTMLCanvasElement;
  private readonly script: HTMLScriptElement;

  constructor(
    container: HTMLElement,
    private readonly onMove: MoveFn,
    base = GAME_BASE,
  ) {
    const canvas = document.createElement("canvas");
    canvas.id = "vexel-canvas";
    canvas.width = 600;
    canvas.height = 600;
    canvas.tabIndex = 0;
    canvas.style.cssText =
      "width:100%;aspect-ratio:1;display:block;border-radius:var(--radius,10px);outline:none;";
    container.appendChild(canvas);
    this.canvas = canvas;

    canvas.addEventListener("click", (e) => {
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) * (canvas.width / r.width);
      const y = (e.clientY - r.top) * (canvas.height / r.height);
      this.call("clickAt", ["number", "number"], [x, y]);
    });

    window.__chess = { onMove: (f, t, p) => this.onMove(f, t, p) };
    window.Module = {
      canvas,
      locateFile: (path: string) => `${base}/${path}`,
      print: () => {},
      printErr: (t: string) => console.error(t),
      onRuntimeInitialized: () => {
        this.ready = true;
        for (const fn of this.queue) fn();
        this.queue.length = 0;
      },
    };

    const script = document.createElement("script");
    script.src = `${base}/ajedrez.js`;
    document.body.appendChild(script);
    this.script = script;
  }

  private call(fn: string, types: string[], args: unknown[]): void {
    const run = () => window.Module?.ccall?.(fn, null, types, args);
    if (this.ready) run();
    else this.queue.push(run);
  }

  applyFen(fen: string): void {
    this.call("applyFen", ["string"], [fen]);
  }
  setInteractive(on: boolean): void {
    this.call("setInteractive", ["number"], [on ? 1 : 0]);
  }
  // Vexel aún dibuja siempre con blancas abajo; orientación/resalte quedan pendientes.
  setOrientation(_color: Color): void {}
  highlight(_squares: string[]): void {}
  destroy(): void {
    this.script.remove();
    this.canvas.remove();
  }
}

export type BoardKind = "vexel" | "canvas";

/** Crea el tablero dentro de `container`. `?board=canvas` fuerza el canvas interino. */
export function createBoard(container: HTMLElement, onMove: MoveFn, kind: BoardKind): BoardController {
  if (kind === "canvas") {
    const canvas = document.createElement("canvas");
    canvas.id = "board";
    container.appendChild(canvas);
    return new CanvasBoard(canvas, onMove);
  }
  return new VexelBoard(container, onMove);
}
