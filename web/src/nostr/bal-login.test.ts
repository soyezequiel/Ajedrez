import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<{ signer: Record<string, ReturnType<typeof vi.fn>> }>,
  constructors: 0,
  logout: vi.fn(),
}));

vi.mock("nostr-game-protocol/bal", () => {
  class BalError extends Error {}
  class BalGameClient {
    constructor() { mocks.constructors += 1; }
    async login() {
      const session = mocks.sessions.shift();
      if (!session) throw new Error("sin sesión mock");
      return { ...session, pubkey: "a".repeat(64), expiresAt: Date.now() + 60_000 };
    }
    logout = mocks.logout;
  }
  class WebPostMessageTransport {}
  return { BalError, BalGameClient, WebPostMessageTransport };
});

function signer(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  return {
    getPublicKey: vi.fn(async () => "a".repeat(64)),
    signEvent: vi.fn(async (event) => event),
    nip04Encrypt: vi.fn(async (_peer, value) => value),
    nip04Decrypt: vi.fn(async (_peer, value) => value),
    nip44Encrypt: vi.fn(async (_peer, value) => value),
    nip44Decrypt: vi.fn(async (_peer, value) => value),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  mocks.sessions.length = 0;
  mocks.constructors = 0;
  mocks.logout.mockReset();
  const opener = { postMessage: vi.fn(), focus: vi.fn() };
  const storage = new Map<string, string>();
  vi.stubGlobal("location", { search: "?lnOrigin=https%3A%2F%2Fluna.example" });
  vi.stubGlobal("sessionStorage", {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
    removeItem: vi.fn((key: string) => storage.delete(key)),
  });
  vi.stubGlobal("window", {
    opener,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

describe("BAL signer recovery", () => {
  it("recovers the launcher origin after the game cleans the URL and reloads", async () => {
    const first = signer();
    const second = signer();
    mocks.sessions.push({ signer: first }, { signer: second });
    const { logoutBal, tryBalLogin } = await import("./bal-login.js");

    await expect(tryBalLogin(vi.fn())).resolves.not.toBeNull();
    await logoutBal();
    location.search = "";

    const restored = await tryBalLogin(vi.fn());
    await expect(restored?.getPublicKey()).resolves.toBe("a".repeat(64));
    expect(mocks.constructors).toBe(2);
    expect(second.getPublicKey).toHaveBeenCalledOnce();
  });

  it("forgets the saved launcher on an explicit logout", async () => {
    mocks.sessions.push({ signer: signer() });
    const { logoutBal, tryBalLogin } = await import("./bal-login.js");

    await expect(tryBalLogin(vi.fn())).resolves.not.toBeNull();
    await logoutBal({ forgetLauncher: true });
    location.search = "";

    await expect(tryBalLogin(vi.fn())).resolves.toBeNull();
    expect(mocks.constructors).toBe(1);
  });

  it("renegotiates BAL and retries once when the ephemeral signer dies", async () => {
    const firstEncrypt = vi.fn().mockRejectedValue(new Error("sesión cerrada"));
    const secondEncrypt = vi.fn(async (_peer, value) => `recuperado:${value}`);
    mocks.sessions.push(
      { signer: signer({ nip44Encrypt: firstEncrypt }) },
      { signer: signer({ nip44Encrypt: secondEncrypt }) },
    );
    const { tryBalLogin } = await import("./bal-login.js");
    const balSigner = await tryBalLogin(vi.fn());

    await expect(balSigner?.nip44Encrypt?.("b".repeat(64), "reto"))
      .resolves.toBe("recuperado:reto");
    expect(mocks.constructors).toBe(2);
    expect(firstEncrypt).toHaveBeenCalledOnce();
    expect(secondEncrypt).toHaveBeenCalledOnce();
  });
});
