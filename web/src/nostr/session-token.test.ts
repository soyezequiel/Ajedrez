import { describe, expect, it, vi } from "vitest";
import {
  clearSessionToken,
  readSessionToken,
  readSessionTokenOrigin,
  sessionTokenBelongsToPubkey,
  sessionTokenPubkey,
  sessionTokenRequiresBal,
  writeSessionToken,
} from "./session-token.js";

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

describe("session token origin", () => {
  it("exige BAL para tokens marcados y para tokens legados sin signer persistido", () => {
    expect(sessionTokenRequiresBal("bal", true)).toBe(true);
    expect(sessionTokenRequiresBal(null, false)).toBe(true);
    expect(sessionTokenRequiresBal("standalone", false)).toBe(false);
    expect(sessionTokenRequiresBal(null, true)).toBe(false);
  });

  it("recuerda que la sesión fue iniciada con BAL", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });

    writeSessionToken("token-bal", "bal");

    expect(readSessionToken()).toBe("token-bal");
    expect(readSessionTokenOrigin()).toBe("bal");

    clearSessionToken();
    expect(readSessionToken()).toBeNull();
    expect(readSessionTokenOrigin()).toBeNull();
    vi.unstubAllGlobals();
  });

  it("mantiene como desconocido el origen de tokens anteriores a esta marca", () => {
    const storage = new Map<string, string>([["ajedrez.session.v1", "token-viejo"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });

    expect(readSessionToken()).toBe("token-viejo");
    expect(readSessionTokenOrigin()).toBeNull();
    vi.unstubAllGlobals();
  });
});
