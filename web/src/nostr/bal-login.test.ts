import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<{ signer: Record<string, ReturnType<typeof vi.fn>> } | Error>,
  constructors: 0,
  logout: vi.fn(),
}));

vi.mock("nostr-game-protocol/bal", () => {
  class BalError extends Error {
    constructor(public code: string, message: string) { super(message); }
  }
  class BalGameClient {
    constructor() { mocks.constructors += 1; }
    async login() {
      const session = mocks.sessions.shift();
      if (!session) throw new Error("sin sesión mock");
      if (session instanceof Error) throw session;
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
  it("publishes navbar states while Luna connects and signs", async () => {
    let finishSigning!: () => void;
    const signEvent = vi.fn((event) => new Promise((resolve) => {
      finishSigning = () => resolve(event);
    }));
    mocks.sessions.push({ signer: signer({ signEvent }) });
    const {
      getBalSignerStatus,
      logoutBal,
      subscribeBalSignerStatus,
      tryBalLogin,
    } = await import("./bal-login.js");
    const phases: string[] = [];
    const unsubscribe = subscribeBalSignerStatus((status) => phases.push(status.phase));

    const balSigner = await tryBalLogin(vi.fn());
    expect(getBalSignerStatus().phase).toBe("connected");
    const signing = balSigner!.signEvent({ kind: 1, created_at: 1, tags: [], content: "test" });
    expect(getBalSignerStatus().phase).toBe("signing");
    finishSigning();
    await signing;
    expect(getBalSignerStatus().phase).toBe("signed");
    expect(phases).toEqual(expect.arrayContaining(["connecting", "connected", "signing", "signed"]));

    unsubscribe();
    await logoutBal({ forgetLauncher: true });
  });

  it("exposes a rejected launcher request", async () => {
    const { BalError } = await import("nostr-game-protocol/bal");
    mocks.sessions.push(new BalError("USER_REJECTED", "El usuario rechazó el acceso BAL"));
    const { getBalSignerStatus, tryBalLogin } = await import("./bal-login.js");

    await expect(tryBalLogin(vi.fn())).resolves.toBeNull();
    expect(getBalSignerStatus()).toMatchObject({
      phase: "rejected",
      detail: "El usuario rechazó el acceso BAL",
    });
  });

  it("detects the persisted launcher context before reconnecting", async () => {
    const { hasBalLauncherContext } = await import("./bal-login.js");

    expect(hasBalLauncherContext()).toBe(true);
    location.search = "";
    expect(hasBalLauncherContext()).toBe(true);
  });

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
