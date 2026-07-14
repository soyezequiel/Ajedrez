import type { Color, MovePayload } from "./protocol.js";

export type MoveFn = (from: string, to: string, promo: string) => void;
export type BoardFeedback = "pickup" | "drop" | "invalid";
export type FeedbackFn = (event: BoardFeedback) => void;
export type LegalTargets = Record<string, string[]>;

export interface BoardController {
  applyFen(fen: string, move?: MovePayload | null): void;
  setInteractive(on: boolean): void;
  setOrientation(color: Color): void;
  setLegalTargets(targets: LegalTargets): void;
  highlight(squares: string[]): void;
  showCountdown(): void;
  confirmMove(): void;
  rejectMove(): void;
  destroy(): void;
}

const GAME_BASE = (import.meta.env.VITE_GAME_BASE as string | undefined) ?? "/game";
// ajedrez.js, ajedrez.wasm y ajedrez.data son una unidad inseparable.
const GAME_ASSET_VERSION = (import.meta.env.VITE_GAME_ASSET_VERSION as string | undefined) ?? "vexel-alpha-depth-20260714-1";
const GAME_SIZE = 600;


export function parseFen(fen: string): (string | null)[] {
  const placement: (string | null)[] = new Array(64).fill(null);
  let index = 0;
  for (const char of fen.split(" ")[0] ?? "") {
    if (char === "/") continue;
    if (char >= "1" && char <= "8") index += Number(char);
    else placement[index++] = (char === char.toUpperCase() ? "w" : "b") + char.toUpperCase();
  }
  return placement;
}

/** Devuelve el mismo FEN sin la pieza indicada, preservando el resto de campos. */
export function fenWithoutPiece(fen: string, index: number): string {
  if (index < 0 || index >= 64) return fen;
  const fields = fen.trim().split(/\s+/);
  const placement = parseFen(fen);
  placement[index] = null;
  const ranks: string[] = [];
  for (let rank = 0; rank < 8; rank++) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const code = placement[rank * 8 + file];
      if (!code) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      const piece = code[1] ?? "";
      row += code[0] === "w" ? piece : piece.toLowerCase();
    }
    if (empty) row += empty;
    ranks.push(row);
  }
  fields[0] = ranks.join("/");
  return fields.join(" ");
}

export function indexToSquare(index: number): string {
  return String.fromCharCode(97 + (index % 8)) + (8 - Math.floor(index / 8));
}

export function squareToIndex(square: string): number {
  if (!/^[a-h][1-8]$/.test(square)) return -1;
  return (8 - Number(square[1])) * 8 + square.charCodeAt(0) - 97;
}

/** El puente JS bloquea el input sin depender del estado asíncrono de WASM. */
export function acceptsBoardInput(interactive: boolean, pending: boolean): boolean {
  return interactive && !pending;
}


declare global {
  interface Window {
    Module?: { ccall?: (name: string, ret: string | null, types: string[], args: unknown[]) => unknown; [key: string]: unknown };
    __chess?: { onMove: MoveFn; onFeedback: FeedbackFn; onVexelReady: () => void };
  }
}


export class VexelBoard implements BoardController {
  private ready = false;
  private readonly queue: Array<() => void> = [];
  private readonly canvas: HTMLCanvasElement;
  private readonly script: HTMLScriptElement;
  private readonly canvasStyleObserver: MutationObserver;
  private failed = false;
  private readonly startupTimer: ReturnType<typeof setTimeout>;
  private pointerId: number | null = null;
  private pointerFrame: number | null = null;
  private pendingPointerMove: [number, number] | null = null;
  private pointerBounds: DOMRect | null = null;
  private placement: (string | null)[] = new Array(64).fill(null);
  private lastFen = "";
  private pending = false;
  private interactive = false;

  constructor(
    container: HTMLElement,
    onMove: MoveFn,
    onFeedback: FeedbackFn,
    private readonly onUnavailable: (reason: string) => void,
    base = GAME_BASE,
  ) {
    const canvas = document.createElement("canvas");
    canvas.id = "vexel-canvas";
    canvas.width = GAME_SIZE;
    canvas.height = GAME_SIZE;
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "grid");
    canvas.setAttribute("aria-label", "Tablero de ajedrez Vexel interactivo");
    canvas.setAttribute("aria-description", "Usá las flechas para recorrer las casillas, Enter para seleccionar o mover y Escape para cancelar.");
    container.appendChild(canvas);
    this.canvas = canvas;

    const fitCanvas = () => {
      if (canvas.style.getPropertyValue("width") !== "100%") canvas.style.setProperty("width", "100%", "important");
      if (canvas.style.getPropertyValue("height") !== "100%") canvas.style.setProperty("height", "100%", "important");
    };
    this.canvasStyleObserver = new MutationObserver(fitCanvas);
    this.canvasStyleObserver.observe(canvas, { attributes: true, attributeFilter: ["style"] });
    fitCanvas();

    canvas.addEventListener("pointerdown", this.pointerDown);
    canvas.addEventListener("pointermove", this.pointerMove);
    canvas.addEventListener("pointerup", this.pointerUp);
    canvas.addEventListener("pointercancel", this.pointerCancel);
    canvas.addEventListener("keydown", this.keyDown);
    canvas.addEventListener("focus", this.focus);
    canvas.addEventListener("blur", this.blur);

    window.__chess = {
      onMove: (from, to, promo) => {
        if (!acceptsBoardInput(this.interactive, this.pending)) {
          this.call("rejectMove", [], []);
          return;
        }
        this.pending = true;
        onMove(from, to, promo);
      },
      onFeedback,
      onVexelReady: () => {
        clearTimeout(this.startupTimer);
        console.info("[chess-board] renderer=vexel-native-interactions");
        fitCanvas();
        requestAnimationFrame(fitCanvas);
        this.ready = true;
        for (const fn of this.queue) fn();
        this.queue.length = 0;
      },
    };
    window.Module = {
      canvas,
      locateFile: (path: string) => `${base}/${path}?v=${encodeURIComponent(GAME_ASSET_VERSION)}`,
      print: () => {},
      printErr: (value: string) => {
        console.error(value);
        if (/RangeDefect|unhandled exception|program exited|Aborted|failed to asynchronously prepare wasm/i.test(value)) this.fail(value);
      },
      onRuntimeInitialized: () => {
        fitCanvas();
        requestAnimationFrame(fitCanvas);
      },
    };
    this.script = document.createElement("script");
    this.script.src = `${base}/ajedrez.js?v=${encodeURIComponent(GAME_ASSET_VERSION)}`;
    this.script.onerror = () => this.fail("No se pudo cargar el runtime de Vexel");
    document.body.appendChild(this.script);
    this.startupTimer = setTimeout(() => this.fail("Vexel tardó demasiado en iniciar"), 12_000);
  }

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    clearTimeout(this.startupTimer);
    queueMicrotask(() => this.onUnavailable(reason));
  }

  private call(fn: string, types: string[], args: unknown[]): void {
    const run = () => window.Module?.ccall?.(fn, null, types, args);
    if (this.ready) run(); else this.queue.push(run);
  }

  private coordinates(event: PointerEvent): [number, number] {
    const bounds = this.pointerBounds ?? this.canvas.getBoundingClientRect();
    return [
      ((event.clientX - bounds.left) / bounds.width) * GAME_SIZE,
      ((event.clientY - bounds.top) / bounds.height) * GAME_SIZE,
    ];
  }

  private flushPointerMove = (): void => {
    this.pointerFrame = null;
    const position = this.pendingPointerMove;
    this.pendingPointerMove = null;
    if (!position || this.pointerId === null) return;
    this.call("pointerMove", ["number", "number"], position);
  };

  applyFen(fen: string, move?: MovePayload | null): void {
    const previous = this.placement;
    const wasPending = this.pending;
    const changed = fen !== this.lastFen;
    this.lastFen = fen;
    this.placement = parseFen(fen);
    this.pending = false;
    if (!wasPending && move && changed) {
      const from = squareToIndex(move.from);
      const to = squareToIndex(move.to);
      const code = previous[from];
      const capture = Boolean(previous[to]) || Boolean(code?.[1] === "P" && from % 8 !== to % 8);
      this.call("applyFenAnimated", ["string", "string", "string", "number"], [fen, move.from, move.to, capture ? 1 : 0]);
    } else {
      this.call("applyFen", ["string"], [fen]);
    }
  }

  setInteractive(on: boolean): void {
    this.interactive = on;
    if (!on) this.cancelActivePointer();
    this.call("setInteractive", ["number"], [on ? 1 : 0]);
  }

  setOrientation(color: Color): void {
    this.call("setOrientation", ["number"], [color === "b" ? 1 : 0]);
  }

  setLegalTargets(targets: LegalTargets): void {
    const payload = Object.entries(targets)
      .filter(([, destinations]) => destinations.length > 0)
      .map(([from, destinations]) => `${from}:${destinations.join(",")}`)
      .join(";");
    this.call("setLegalMoves", ["string"], [payload]);
  }

  highlight(squares: string[]): void {
    this.call("highlight", ["string"], [squares.join(" ")]);
  }

  showCountdown(): void {
    this.call("showCountdown", [], []);
  }

  rejectMove(): void {
    this.pending = false;
    this.call("rejectMove", [], []);
  }

  confirmMove(): void {
    this.pending = false;
    this.call("confirmMove", [], []);
  }

  private cancelActivePointer(): void {
    if (this.pointerId === null) return;
    if (this.pointerFrame !== null) cancelAnimationFrame(this.pointerFrame);
    this.pointerFrame = null;
    this.pendingPointerMove = null;
    this.call("pointerCancel", [], []);
    if (this.canvas.hasPointerCapture(this.pointerId)) this.canvas.releasePointerCapture(this.pointerId);
    this.pointerId = null;
    this.pointerBounds = null;
  }

  private pointerDown = (event: PointerEvent): void => {
    if (!acceptsBoardInput(this.interactive, this.pending)) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    this.pointerId = event.pointerId;
    this.pointerBounds = this.canvas.getBoundingClientRect();
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.focus({ preventScroll: true });
    const [x, y] = this.coordinates(event);
    this.call("pointerDown", ["number", "number"], [x, y]);
  };

  private pointerMove = (event: PointerEvent): void => {
    if (!acceptsBoardInput(this.interactive, this.pending)) return;
    if (this.pointerId !== event.pointerId) return;
    this.pendingPointerMove = this.coordinates(event);
    if (this.pointerFrame === null) this.pointerFrame = requestAnimationFrame(this.flushPointerMove);
  };

  private pointerUp = (event: PointerEvent): void => {
    if (!acceptsBoardInput(this.interactive, this.pending)) {
      this.cancelActivePointer();
      return;
    }
    if (this.pointerId !== event.pointerId) return;
    if (this.pointerFrame !== null) cancelAnimationFrame(this.pointerFrame);
    this.pointerFrame = null;
    this.pendingPointerMove = null;
    const [x, y] = this.coordinates(event);
    this.call("pointerUp", ["number", "number"], [x, y]);
    this.canvas.releasePointerCapture(event.pointerId);
    this.pointerId = null;
    this.pointerBounds = null;
  };

  private pointerCancel = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) return;
    this.cancelActivePointer();
  };

  private keyDown = (event: KeyboardEvent): void => {
    if (!acceptsBoardInput(this.interactive, this.pending)) return;
    const codes: Record<string, number> = {
      ArrowLeft: 0, ArrowRight: 1, ArrowUp: 2, ArrowDown: 3, Enter: 4, " ": 4, Escape: 5,
    };
    const code = codes[event.key];
    if (code === undefined) return;
    event.preventDefault();
    this.call("keyInput", ["number"], [code]);
  };

  private focus = (): void => this.call("setKeyboardFocus", ["number"], [1]);
  private blur = (): void => this.call("setKeyboardFocus", ["number"], [0]);

  destroy(): void {
    if (this.pointerFrame !== null) cancelAnimationFrame(this.pointerFrame);
    clearTimeout(this.startupTimer);
    this.canvasStyleObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.pointerDown);
    this.canvas.removeEventListener("pointermove", this.pointerMove);
    this.canvas.removeEventListener("pointerup", this.pointerUp);
    this.canvas.removeEventListener("pointercancel", this.pointerCancel);
    this.canvas.removeEventListener("keydown", this.keyDown);
    this.canvas.removeEventListener("focus", this.focus);
    this.canvas.removeEventListener("blur", this.blur);
    this.script.remove();
    this.canvas.remove();
  }
}


export function createBoard(
  container: HTMLElement,
  onMove: MoveFn,
  onFeedback: FeedbackFn = () => {},
  onUnavailable: (reason: string) => void = () => {},
): BoardController {
  return new VexelBoard(container, onMove, onFeedback, onUnavailable);
}
