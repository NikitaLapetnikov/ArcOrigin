import "server-only";

import {
  TOKEN_DESCRIPTION_MAX_CHARACTERS,
  normalizeTelegramUrl,
  normalizeWebsiteUrl,
  normalizeXUrl,
} from "@/lib/token-metadata";
import { ipfsMediaURL, parseIpfsPath } from "@/lib/ipfs";
import { readStoredTokenMetadata } from "@/lib/server/token-metadata-store";

const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const CACHE_LIMIT = 200;
const SUCCESS_CACHE_TTL_MS = 60 * 60 * 1_000;
const FAILURE_CACHE_TTL_MS = 15 * 1_000;
const PUBLIC_GATEWAY_URL = "https://ipfs.io/ipfs/";
const PINATA_GATEWAY_URL = "https://gateway.pinata.cloud/ipfs/";
const GATEWAY_TIMEOUT_MS = 15_000;

export type ResolvedTokenMetadata = {
  description?: string;
  image?: string;
  website?: string;
  x?: string;
  telegram?: string;
};

declare global {
  var __arcOriginResolvedMetadata: Map<string, { value: ResolvedTokenMetadata | null; cachedAt: number }> | undefined;
}

const cache = globalThis.__arcOriginResolvedMetadata ?? new Map<string, { value: ResolvedTokenMetadata | null; cachedAt: number }>();
globalThis.__arcOriginResolvedMetadata = cache;

function configuredGatewayBase() {
  const configured = process.env.IPFS_GATEWAY_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:") return null;
    return `${url.toString().replace(/\/+$/, "")}/`;
  } catch {
    return null;
  }
}

export function ipfsGatewayURL(uri: string) {
  return ipfsMediaURL(uri);
}

function metadataGatewayURLs(uri: string) {
  const path = parseIpfsPath(uri);
  if (!path) return [];
  const configured = configuredGatewayBase();
  return [...new Set([
    configured ? `${configured}${path}` : "",
    `${PINATA_GATEWAY_URL}${path}`,
    `${PUBLIC_GATEWAY_URL}${path}`,
  ].filter(Boolean))];
}

function text(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength
    ? value.trim()
    : undefined;
}

function descriptionText(value: unknown) {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim().length <= TOKEN_DESCRIPTION_MAX_CHARACTERS
    ? value.trim()
    : undefined;
}

function cacheMetadata(key: string, value: ResolvedTokenMetadata | null) {
  if (cache.size >= CACHE_LIMIT && !cache.has(key)) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { value, cachedAt: Date.now() });
}

function normalizeResolvedMetadata(payload: Record<string, unknown>) {
  const properties = payload.properties && typeof payload.properties === "object"
    ? payload.properties as Record<string, unknown>
    : {};
  const imageURI = text(payload.image, 512) ?? "";
  const websiteValue = text(payload.external_url, 200) ?? text(properties.website, 200) ?? "";
  const xValue = text(properties.x, 200) ?? "";
  const telegramValue = text(properties.telegram, 200) ?? "";
  return {
    description: descriptionText(payload.description),
    image: imageURI ? ipfsMediaURL(imageURI) || undefined : undefined,
    website: websiteValue ? normalizeWebsiteUrl(websiteValue) : undefined,
    x: xValue ? normalizeXUrl(xValue) : undefined,
    telegram: telegramValue ? normalizeTelegramUrl(telegramValue) : undefined,
  } satisfies ResolvedTokenMetadata;
}

async function readLimitedBody(response: Response) {
  if (!response.body) throw new Error("Metadata response has no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_METADATA_BYTES) {
      await reader.cancel();
      throw new Error("Metadata is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function resolveTokenMetadata(metadataURI: string): Promise<ResolvedTokenMetadata | null> {
  if (!metadataURI) return null;
  const cached = cache.get(metadataURI);
  if (cached) {
    const ttl = cached.value ? SUCCESS_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS;
    if (Date.now() - cached.cachedAt < ttl) return cached.value;
    cache.delete(metadataURI);
  }
  const urls = metadataGatewayURLs(metadataURI);
  if (urls.length === 0) return null;

  try {
    const ipfsPath = parseIpfsPath(metadataURI);
    const stored = ipfsPath ? await readStoredTokenMetadata(ipfsPath) : null;
    const payload = stored ?? await Promise.any(urls.map(async (url) => {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (!response.ok || (contentLength > 0 && contentLength > MAX_METADATA_BYTES)) throw new Error("Invalid metadata response.");
      const body = await readLimitedBody(response);
      return JSON.parse(body) as Record<string, unknown>;
    }));
    const result = normalizeResolvedMetadata(payload);
    cacheMetadata(metadataURI, result);
    return result;
  } catch {
    cacheMetadata(metadataURI, null);
    return null;
  }
}
