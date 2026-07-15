/** Adaptador mínimo de Ajedrez sobre el kit BAL reutilizable. */
import {
  createBalBrowserLogin,
  type BalSignerPhase,
  type BalSignerStatus,
} from "./bal-kit/index.js";
import type { ChessSigner } from "./signer-core.js";

const GAME_ID = "ajedrez";
const PERMISSIONS = [
  "get_public_key",
  "sign_event:1",
  "sign_event:13",
  "sign_event:22242",
  "sign_event:30315",
  "sign_event:31339",
  "sign_event:9734",
  "nip04_encrypt",
  "nip04_decrypt",
  "nip44_encrypt",
  "nip44_decrypt",
];

const bal = createBalBrowserLogin({
  gameId: GAME_ID,
  gameName: "Ajedrez",
  permissions: PERMISSIONS,
  launcherOriginStorageKey: `${GAME_ID}.bal.launcher-origin.v1`,
  shared: {
    // Vite exige ver el constructor y new URL juntos para emitir el chunk.
    createWorker: () => new SharedWorker(
      new URL("./bal-kit/worker-entry.ts", import.meta.url),
      { type: "module", name: `${GAME_ID}-bal-v2` },
    ),
    activeHintKey: `${GAME_ID}.bal.shared-active.v1`,
  },
});

export type { BalSignerPhase, BalSignerStatus };

export function getBalSignerStatus(): BalSignerStatus {
  return bal.getStatus();
}

export function subscribeBalSignerStatus(
  listener: (status: BalSignerStatus) => void,
): () => void {
  return bal.subscribeStatus(listener);
}

export function hasBalLauncherContext(): boolean {
  return bal.hasLauncherContext();
}

export async function tryBalLogin(
  onLauncherLogout: () => void,
  onConsentRequired?: () => void,
): Promise<ChessSigner | null> {
  return bal.connect(onLauncherLogout, onConsentRequired) as Promise<ChessSigner | null>;
}

export function requestBalLauncherFocus(): void {
  bal.requestLauncherFocus();
}

export function logoutBal(options?: { forgetLauncher?: boolean }): Promise<void> {
  return bal.logout(options);
}
