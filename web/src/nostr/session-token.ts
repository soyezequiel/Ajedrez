type SessionTokenPayload = {
  p?: unknown;
};

const HEX_PUBKEY = /^[0-9a-f]{64}$/i;

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
