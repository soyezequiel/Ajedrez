type SessionTokenPayload = {
  p?: unknown;
};

const HEX_PUBKEY = /^[0-9a-f]{64}$/i;
const SESSION_TOKEN_KEY = "ajedrez.session.v1";
const SESSION_TOKEN_ORIGIN_KEY = "ajedrez.session-origin.v1";

export type SessionTokenOrigin = "bal" | "standalone";

/**
 * Persiste el token junto con el flujo que creó la sesión. BAL usa un signer
 * efímero, así que su token no debe sobrevivir si el juego se abre por otro flujo.
 */
export function writeSessionToken(token: string, origin: SessionTokenOrigin): void {
  try {
    localStorage.setItem(SESSION_TOKEN_KEY, token);
    localStorage.setItem(SESSION_TOKEN_ORIGIN_KEY, origin);
  } catch {
    /* storage bloqueado: la sesión no persiste */
  }
}

export function readSessionToken(): string | null {
  try {
    return localStorage.getItem(SESSION_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function readSessionTokenOrigin(): SessionTokenOrigin | null {
  try {
    const origin = localStorage.getItem(SESSION_TOKEN_ORIGIN_KEY);
    return origin === "bal" || origin === "standalone" ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Decide si un token depende de BAL. El segundo caso migra tokens anteriores a
 * la marca de origen: los flujos propios persisten signer; BAL deliberadamente no.
 */
export function sessionTokenRequiresBal(
  origin: SessionTokenOrigin | null,
  hasPersistedSigner: boolean,
): boolean {
  return origin === "bal" || (origin === null && !hasPersistedSigner);
}

export function clearSessionToken(): void {
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem(SESSION_TOKEN_ORIGIN_KEY);
  } catch {
    /* noop */
  }
}

/**
 * Lee únicamente la identidad declarada por el token para decidir si puede
 * reutilizarse en el cliente. La firma y la expiración siguen verificándose en
 * el servidor; este dato nunca se usa como prueba de autenticación.
 */
export function sessionTokenPubkey(token: string): string | null {
  const separator = token.indexOf(".");
  if (separator <= 0) return null;

  try {
    const body = token.slice(0, separator)
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = body.padEnd(Math.ceil(body.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as SessionTokenPayload;
    return typeof payload.p === "string" && HEX_PUBKEY.test(payload.p)
      ? payload.p.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

export function sessionTokenBelongsToPubkey(token: string, pubkey: string): boolean {
  const normalizedPubkey = pubkey.trim().toLowerCase();
  return HEX_PUBKEY.test(normalizedPubkey)
    && sessionTokenPubkey(token) === normalizedPubkey;
}
