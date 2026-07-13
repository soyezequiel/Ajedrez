import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Request, Response } from "express";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** Proxy same-origin para avatares Nostr bloqueados por COEP/CORP. */
export async function profileImageProxy(req: Request, res: Response): Promise<void> {
  const raw = typeof req.query.url === "string" ? req.query.url : "";
  try {
    let url = new URL(raw);
    let upstream: globalThis.Response | null = null;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      await assertPublicHttpUrl(url);
      upstream = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(8_000),
        headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" },
      });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) throw new Error("redirect inválido");
      url = new URL(location, url);
    }
    if (!upstream?.ok || !upstream.body) throw new Error("imagen no disponible");
    const type = upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!type.startsWith("image/")) throw new Error("el recurso no es una imagen");
    const declared = Number(upstream.headers.get("content-length") ?? 0);
    if (declared > MAX_IMAGE_BYTES) throw new Error("imagen demasiado grande");

    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("imagen demasiado grande");
      }
      chunks.push(value);
    }

    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.send(Buffer.concat(chunks, size));
  } catch {
    res.status(404).setHeader("Cache-Control", "public, max-age=300").end();
  }
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("URL inválida");
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error("host privado");
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("host privado");
  }
}

export function isPrivateIp(address: string): boolean {
  const ip = address.toLowerCase();
  if (ip === "::1" || ip === "::" || ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(ip) === 4 ? ip : null);
  if (!ipv4) return false;
  const [a = 0, b = 0] = ipv4.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
