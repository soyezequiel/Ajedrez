import { NGE, type NgeBet, type NgeInfo } from "nostr-game-protocol/nge";

/**
 * Puerto server-side del canal de escrow NGE (Nostr Game Escrow). El juego opera
 * el escrow con una única URI de conexión (`NGE_CONNECTION`, secreto de servidor):
 * los jugadores solo pagan un invoice Lightning, nunca ven la credencial. El
 * resultado lo dicta este server (es el oráculo) — nunca el marcador del cliente.
 */

let nge: NGE | null = null;

/** ¿Hay credencial de escrow configurada? Sin ella, las apuestas quedan apagadas. */
export function betsEnabled(): boolean {
  return Boolean(process.env.NGE_CONNECTION);
}

function client(): NGE {
  if (!betsEnabled())
    throw new BetError("BETS_DISABLED", "Las apuestas están deshabilitadas");
  nge ??= NGE.fromEnv("NGE_CONNECTION");
  return nge;
}

export interface BetSeat {
  /** Id de asiento estable = color ("w"/"b"). */
  seatId: string;
  /** Pubkey hex del jugador (habilita el payout social). */
  pubkey: string;
}

export interface CreatedBet {
  betId: string;
  stakeSats: number;
  potSats: number;
  deposits: { seatId: string; bolt11: string | null; amountSats: number }[];
}

/** Crea la apuesta (un bolt11 por asiento). `clientRef` da idempotencia. */
export async function createBet(opts: {
  clientRef: string;
  roomId: string;
  stakeSats: number;
  seats: BetSeat[];
  condition: string;
}): Promise<CreatedBet> {
  const bet = await client().createBet({
    seats: opts.seats,
    stakeSats: opts.stakeSats,
    condition: opts.condition,
    clientRef: opts.clientRef,
    roomId: opts.roomId,
  });
  return {
    betId: bet.betId,
    stakeSats: bet.stakeSats,
    potSats: bet.potSats,
    deposits: bet.deposits.map((d) => ({
      seatId: d.seatId,
      bolt11: d.bolt11,
      amountSats: d.amountSats,
    })),
  };
}

/** Sigue la apuesta con push + respaldo; corta solo en estado terminal. */
export function watchBet(betId: string, cb: (bet: NgeBet) => void): () => void {
  return client().watchBet(betId, cb);
}

/** Reporta ganadores por seatId (color). Vacío = empate/anulación → reembolso. */
export function settleBet(betId: string, winnerSeatIds: string[]): Promise<unknown> {
  return client().reportResult(betId, winnerSeatIds);
}

/** Cancela la apuesta pre-fondeo (reembolsa a quien ya pagó). */
export function cancelBet(betId: string): Promise<unknown> {
  return client().cancelBet(betId);
}

/** Capacidades y límites del escrow (stake mín/máx, comisión). */
export function getInfo(): Promise<NgeInfo> {
  return client().getInfo();
}

export class BetError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BetError";
  }
}
