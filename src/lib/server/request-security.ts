import "server-only";

import type { NextRequest } from "next/server";

export function isSameOriginRequest(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const requestOrigin = new URL(origin).origin.toLowerCase();
    const allowedOrigins = new Set([request.nextUrl.origin.toLowerCase()]);
    const host = request.headers.get("host")?.trim();
    if (host) allowedOrigins.add(`${request.nextUrl.protocol}//${host}`.toLowerCase());
    const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim();
    if (configuredOrigin) allowedOrigins.add(new URL(configuredOrigin).origin.toLowerCase());
    return allowedOrigins.has(requestOrigin);
  } catch {
    return false;
  }
}

export async function readLimitedText(request: Request, maximumBytes: number) {
  return new TextDecoder("utf-8", { fatal: true }).decode(await readLimitedBytes(request, maximumBytes));
}

export async function readLimitedBytes(request: Request, maximumBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maximumBytes) {
      throw new Error("Request body is too large.");
    }
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("Request body is too large.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function requestClientKey(request: NextRequest) {
  // Caddy supplies the forwarding chain. Prefer it over X-Real-IP, which a
  // direct client can set and otherwise use to evade per-client limits.
  const candidate = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")
    ?? "";
  return candidate.length <= 64 && /^[0-9a-f:.]+$/i.test(candidate) ? candidate.toLowerCase() : "unknown";
}
