import { describe, expect, it } from "vitest";
import { sessionTokenBelongsToPubkey, sessionTokenPubkey } from "./session-token.js";

function tokenFor(pubkey: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify({
    p: pubkey,
    n: "npub1test",
    d: "Jugador",
    e: 4_102_444_800,
  }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const body = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${body}.firma-del-servidor`;
}

describe("session token identity", () => {
  it("permite reutilizar el token cuando pertenece a la identidad BAL activa", () => {
    const pubkey = "a".repeat(64);

    expect(sessionTokenPubkey(tokenFor(pubkey))).toBe(pubkey);
    expect(sessionTokenBelongsToPubkey(tokenFor(pubkey), pubkey)).toBe(true);
  });

  it("rechaza el token guardado de otra cuenta", () => {
    const previousAccount = "a".repeat(64);
    const currentBalAccount = "b".repeat(64);

    expect(sessionTokenBelongsToPubkey(
      tokenFor(previousAccount),
      currentBalAccount,
    )).toBe(false);
  });

  it.each([
    "",
    "sin-separador",
    "@@@.firma",
    tokenFor("corta"),
    tokenFor(42),
  ])("rechaza tokens sin una pubkey válida: %s", (token) => {
    expect(sessionTokenPubkey(token)).toBeNull();
    expect(sessionTokenBelongsToPubkey(token, "a".repeat(64))).toBe(false);
  });
});
