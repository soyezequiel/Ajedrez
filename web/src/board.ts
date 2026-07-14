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
  confirmMove(): void;
  rejectMove(): void;
  destroy(): void;
}

const GAME_BASE = (import.meta.env.VITE_GAME_BASE as string | undefined) ?? "/game";
// ajedrez.js, ajedrez.wasm y ajedrez.data forman una unidad: mezclar versiones
// corrompe los offsets del filesystem precargado. Cambiar este valor al
// regenerar el paquete fuerza una descarga coherente de los tres archivos.
const GAME_ASSET_VERSION = (import.meta.env.VITE_GAME_ASSET_VERSION as string | undefined) ?? "club-cinematic-20260713-3";
const GAME_SIZE = 600;
const GAME_MARGIN = 20;
const GAME_CELL = 70;


export function parseFen(fen: string): (string | null)[] {
  const placement: (string | null)[] = new Array(64).fill(null);
  let index = 0;
  for (const char of fen.split(" ")[0] ?? "") {
    if (char === "/") continue;
    if (char >= "1" && char <= "8") index += Number(char);
    else {
      placement[index++] = (char === char.toUpperCase() ? "w" : "b") + char.toUpperCase();
    }
  }
  return placement;
}

export function indexToSquare(index: number): string {
  return String.fromCharCode(97 + (index % 8)) + (8 - Math.floor(index / 8));
}

export function squareToIndex(square: string): number {
  if (!/^[a-h][1-8]$/.test(square)) return -1;
  return (8 - Number(square[1])) * 8 + square.charCodeAt(0) - 97;
}

abstract class InteractiveBoard implements BoardController {
  protected placement: (string | null)[] = new Array(64).fill(null);
  protected orientation: Color = "w";
  protected interactive = false;
  protected selected: number | null = null;
  protected legal = new Map<number, Set<number>>();
  protected highlighted: number[] = [];
  protected pending: { from: number; to: number; backup: (string | null)[] } | null = null;

  constructor(protected readonly onMove: MoveFn, protected readonly onFeedback: FeedbackFn) {}

  abstract applyFen(fen: string, move?: MovePayload | null): void;
  abstract redraw(): void;
  abstract destroy(): void;

  setInteractive(on: boolean): void {
    this.interactive = on;
    if (!on && !this.pending) this.selected = null;
    this.redraw();
  }

  setOrientation(color: Color): void {
    this.orientation = color;
    this.redraw();
  }

  setLegalTargets(targets: LegalTargets): void {
    this.legal.clear();
    for (const [from, destinations] of Object.entries(targets)) {
      const fromIndex = squareToIndex(from);
      if (fromIndex >= 0) this.legal.set(fromIndex, new Set(destinations.map(squareToIndex).filter((index) => index >= 0)));
    }
    this.redraw();
  }

  highlight(squares: string[]): void {
    this.highlighted = squares.map(squareToIndex).filter((index) => index >= 0);
    this.redraw();
  }

  confirmMove(): void {
    this.pending = null;
    this.selected = null;
    this.redraw();
  }

  rejectMove(): void {
    if (this.pending) this.placement = [...this.pending.backup];
    this.pending = null;
    this.selected = null;
    this.onFeedback("invalid");
    this.redraw();
  }

  protected isMine(index: number): boolean {
    return this.placement[index]?.[0] === this.orientation;
  }

  protected choose(index: number): boolean {
    if (!this.interactive || this.pending) return false;
    if (this.selected !== null && this.legal.get(this.selected)?.has(index)) {
      this.commit(this.selected, index);
      return true;
    }
    if (!this.isMine(index) || !this.legal.has(index)) return false;
    this.selected = index;
    this.onFeedback("pickup");
    this.redraw();
    return true;
  }

  protected commit(from: number, to: number): void {
    const backup = [...this.placement];
    const piece = this.placement[from];
    if (!piece) return;
    this.placement[from] = null;
    this.placement[to] = piece;
    this.pending = { from, to, backup };
    this.selected = null;
    this.onFeedback("drop");
    this.redraw();
    this.onMove(indexToSquare(from), indexToSquare(to), "");
  }

  protected keyboardMove(current: number, key: string): number {
    const viewDelta: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const delta = viewDelta[key];
    if (!delta) return current;
    const logicalX = current % 8;
    const logicalY = Math.floor(current / 8);
    const direction = this.orientation === "w" ? 1 : -1;
    const x = logicalX + delta[0] * direction;
    const y = logicalY + delta[1] * direction;
    return x >= 0 && x < 8 && y >= 0 && y < 8 ? y * 8 + x : current;
  }
}


declare global {
  interface Window {
    Module?: { ccall?: (name: string, ret: string | null, types: string[], args: unknown[]) => unknown; [key: string]: unknown };
    __chess?: { onMove: MoveFn };
  }
}

export class VexelBoard extends InteractiveBoard {
  private ready = false;
  private readonly queue: Array<() => void> = [];
  private readonly canvas: HTMLCanvasElement;
  private readonly script: HTMLScriptElement;
  private readonly layer: HTMLDivElement;
  private readonly canvasStyleObserver: MutationObserver;
  private failed = false;
  private readonly startupTimer: ReturnType<typeof setTimeout>;
  private drag: { pointerId: number; from: number; ghost: HTMLImageElement; moved: boolean; startX: number; startY: number } | null = null;
  private keyboardIndex = squareToIndex("e2");

  constructor(
    private readonly container: HTMLElement,
    onMove: MoveFn,
    onFeedback: FeedbackFn,
    private readonly onUnavailable: (reason: string) => void,
    base = GAME_BASE,
  ) {
    super(onMove, onFeedback);
    const canvas = document.createElement("canvas");
    canvas.id = "vexel-canvas";
    canvas.width = GAME_SIZE;
    canvas.height = GAME_SIZE;
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "grid");
    canvas.setAttribute("aria-label", "Tablero de ajedrez interactivo");
    container.appendChild(canvas);
    this.canvas = canvas;
    const fitCanvas = () => {
      if (canvas.style.getPropertyValue("width") !== "100%") canvas.style.setProperty("width", "100%", "important");
      if (canvas.style.getPropertyValue("height") !== "100%") canvas.style.setProperty("height", "100%", "important");
    };
    this.canvasStyleObserver = new MutationObserver(fitCanvas);
    this.canvasStyleObserver.observe(canvas, { attributes: true, attributeFilter: ["style"] });
    fitCanvas();
    this.layer = document.createElement("div");
    this.layer.className = "board-interaction-layer";
    container.appendChild(this.layer);
    canvas.addEventListener("pointerdown", this.pointerDown);
    canvas.addEventListener("pointermove", this.pointerMove);
    canvas.addEventListener("pointerup", this.pointerUp);
    canvas.addEventListener("pointercancel", this.pointerCancel);
    canvas.addEventListener("keydown", this.keyDown);
    canvas.addEventListener("focus", () => this.redraw());
    canvas.addEventListener("blur", () => this.redraw());

    window.__chess = { onMove };
    window.Module = {
      canvas,
      locateFile: (path: string) => `${base}/${path}?v=${encodeURIComponent(GAME_ASSET_VERSION)}`,
      print: () => {},
      printErr: (value: string) => {
        console.error(value);
        if (/RangeDefect|unhandled exception|program exited|Aborted|failed to asynchronously prepare wasm/i.test(value))
          this.fail(value);
      },
      onRuntimeInitialized: () => {
        clearTimeout(this.startupTimer);
        console.info("[chess-board] renderer=vexel");
        // Emscripten fija el tamaÃ±o CSS del canvas a 600 px con !important.
        // El backing store permanece a 600Â², pero visualmente debe seguir al
        // contenedor para no recortarse en mÃ³vil.
        fitCanvas();
        requestAnimationFrame(fitCanvas);
        this.ready = true;
        for (const fn of this.queue) fn();
        this.queue.length = 0;
      },
    };
    this.script = document.createElement("script");
    this.script.src = `${base}/ajedrez.js?v=${encodeURIComponent(GAME_ASSET_VERSION)}`;
    this.script.onerror = () => this.fail("No se pudo cargar el runtime de Vexel");
    document.body.appendChild(this.script);
    this.startupTimer = setTimeout(() => this.fail("Vexel tardÃ³ demasiado en iniciar"), 12_000);
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

  applyFen(fen: string, move?: MovePayload | null): void {
    const previous = this.placement;
    const wasPending = this.pending !== null;
    this.placement = parseFen(fen);
    this.pending = null;
    this.selected = null;
    this.call("applyFen", ["string"], [fen]);
    if (!wasPending && move) {
      const from = squareToIndex(move.from);
      const to = squareToIndex(move.to);
      const code = previous[from];
      if (code) this.animateRemote(from, to, code);
    } else this.layer.querySelector(".piece-ghost.pending")?.remove();
    this.redraw();
  }

  setInteractive(on: boolean): void {
    super.setInteractive(on);
    this.call("setInteractive", ["number"], [0]); // el shell maneja el gesto para dar feedback inmediato
  }

  setOrientation(color: Color): void {
    super.setOrientation(color);
    this.call("setOrientation", ["number"], [color === "b" ? 1 : 0]);
  }

  highlight(squares: string[]): void {
    super.highlight(squares);
    this.call("highlight", ["string"], [squares.join(" ")]);
  }

  redraw(): void {
    this.layer.querySelectorAll(".legal-target,.selected-square,.keyboard-square").forEach((node) => node.remove());
    if (document.activeElement === this.canvas)
      this.layer.appendChild(this.marker(this.keyboardIndex, "keyboard-square"));
    if (this.selected !== null) {
      this.layer.appendChild(this.marker(this.selected, "selected-square"));
      for (const target of this.legal.get(this.selected) ?? []) this.layer.appendChild(this.marker(target, "legal-target"));
    }
  }

  rejectMove(): void {
    const pending = this.pending;
    super.rejectMove();
    const ghost = this.layer.querySelector<HTMLElement>(".piece-ghost.pending");
    if (ghost && pending) {
      ghost.classList.add("rejected");
      const position = this.viewPosition(pending.from);
      ghost.style.left = `${position.x}%`;
      ghost.style.top = `${position.y}%`;
      setTimeout(() => ghost.remove(), 180);
    }
  }

  confirmMove(): void {
    super.confirmMove();
    this.layer.querySelector(".piece-ghost.pending")?.remove();
  }

  private marker(index: number, className: string): HTMLSpanElement {
    const marker = document.createElement("span");
    marker.className = className;
    const position = this.viewPosition(index);
    marker.style.left = `${position.x}%`;
    marker.style.top = `${position.y}%`;
    return marker;
  }

  private viewPosition(index: number): { x: number; y: number } {
    const file = index % 8;
    const rank = Math.floor(index / 8);
    const x = this.orientation === "w" ? file : 7 - file;
    const y = this.orientation === "w" ? rank : 7 - rank;
    return { x: (GAME_MARGIN + x * GAME_CELL) / GAME_SIZE * 100, y: (GAME_MARGIN + y * GAME_CELL) / GAME_SIZE * 100 };
  }

  private eventIndex(event: PointerEvent): number {
    const bounds = this.canvas.getBoundingClientRect();
    const px = ((event.clientX - bounds.left) / bounds.width) * GAME_SIZE;
    const py = ((event.clientY - bounds.top) / bounds.height) * GAME_SIZE;
    const viewFile = Math.floor((px - GAME_MARGIN) / GAME_CELL);
    const viewRank = Math.floor((py - GAME_MARGIN) / GAME_CELL);
    if (viewFile < 0 || viewFile > 7 || viewRank < 0 || viewRank > 7) return -1;
    const file = this.orientation === "w" ? viewFile : 7 - viewFile;
    const rank = this.orientation === "w" ? viewRank : 7 - viewRank;
    return rank * 8 + file;
  }

  private pointerDown = (event: PointerEvent): void => {
    if (!this.interactive || this.pending || (event.pointerType === "mouse" && event.button !== 0)) return;
    const index = this.eventIndex(event);
    if (this.selected !== null && this.legal.get(this.selected)?.has(index)) {
      this.commitWithGhost(this.selected, index, null);
      return;
    }
    const code = this.placement[index];
    if (!code || !this.isMine(index) || !this.legal.has(index)) return;
    this.selected = index;
    const ghost = document.createElement("img");
    ghost.className = "piece-ghost";
    ghost.src = `/textures/pieces/${code}.png`;
    ghost.alt = "";
    this.layer.appendChild(ghost);
    this.drag = { pointerId: event.pointerId, from: index, ghost, moved: false, startX: event.clientX, startY: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
    this.positionGhost(ghost, event);
    this.onFeedback("pickup");
    this.redraw();
  };

  private pointerMove = (event: PointerEvent): void => {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY) > 5) this.drag.moved = true;
    this.positionGhost(this.drag.ghost, event);
  };

  private pointerUp = (event: PointerEvent): void => {
    if (!this.drag || this.drag.pointerId !== event.pointerId) return;
    const drag = this.drag;
    this.drag = null;
    const target = this.eventIndex(event);
    if (drag.moved && this.legal.get(drag.from)?.has(target)) this.commitWithGhost(drag.from, target, drag.ghost);
    else {
      drag.ghost.remove();
      if (drag.moved) { this.selected = null; this.onFeedback("invalid"); }
      this.redraw();
    }
  };

  private pointerCancel = (): void => { this.drag?.ghost.remove(); this.drag = null; this.selected = null; this.redraw(); };
  private keyDown = (event: KeyboardEvent): void => {
    if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      this.keyboardIndex = this.keyboardMove(this.keyboardIndex, event.key);
      this.redraw();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.choose(this.keyboardIndex);
    } else if (event.key === "Escape") {
      this.selected = null;
      this.redraw();
    }
  };

  private commitWithGhost(from: number, to: number, ghost: HTMLImageElement | null): void {
    const code = this.placement[from];
    if (!code) return;
    const pendingGhost = ghost ?? document.createElement("img");
    if (!ghost) {
      pendingGhost.src = `/textures/pieces/${code}.png`;
      pendingGhost.alt = "";
      this.layer.appendChild(pendingGhost);
    }
    pendingGhost.className = "piece-ghost pending";
    const position = this.viewPosition(to);
    pendingGhost.style.left = `${position.x}%`;
    pendingGhost.style.top = `${position.y}%`;
    super.commit(from, to);
  }

  private animateRemote(from: number, to: number, code: string): void {
    const ghost = document.createElement("img");
    ghost.className = "piece-ghost remote-piece";
    ghost.src = `/textures/pieces/${code}.png`;
    ghost.alt = "";
    const start = this.viewPosition(from);
    const end = this.viewPosition(to);
    ghost.style.left = `${start.x}%`;
    ghost.style.top = `${start.y}%`;
    this.layer.appendChild(ghost);
    requestAnimationFrame(() => {
      ghost.style.left = `${end.x}%`;
      ghost.style.top = `${end.y}%`;
      ghost.style.opacity = ".2";
    });
    setTimeout(() => ghost.remove(), 210);
  }

  private positionGhost(ghost: HTMLElement, event: PointerEvent): void {
    const bounds = this.container.getBoundingClientRect();
    ghost.style.left = `${((event.clientX - bounds.left) / bounds.width) * 100 - 5.83}%`;
    ghost.style.top = `${((event.clientY - bounds.top) / bounds.height) * 100 - 5.83}%`;
  }

  destroy(): void {
    clearTimeout(this.startupTimer);
    this.canvasStyleObserver.disconnect();
    this.canvas.removeEventListener("keydown", this.keyDown);
    this.script.remove();
    this.layer.remove();
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
