import { NextRequest, NextResponse } from "next/server";
import { parseIpfsPath } from "@/lib/ipfs";
import {
  detectImageContentType,
  MAX_MEDIA_BYTES,
  readStoredMedia,
  storeMedia,
} from "@/lib/server/media-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GATEWAY_TIMEOUT_MS = 12_000;
const GATEWAY_BASES = [
  process.env.IPFS_GATEWAY_URL?.trim() ?? "",
  "https://gateway.pinata.cloud/ipfs/",
  "https://dweb.link/ipfs/",
  "https://ipfs.io/ipfs/",
].filter(Boolean);

async function readLimitedImage(response: Response) {
  if (!response.ok || !response.body) throw new Error("Media gateway rejected the request.");
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_MEDIA_BYTES) throw new Error("Media response is too large.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MEDIA_BYTES) {
      await reader.cancel();
      throw new Error("Media response is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!detectImageContentType(bytes)) throw new Error("Gateway response is not a supported image.");
  return bytes;
}

function imageResponse(bytes: Uint8Array, contentType: string) {
  const body = Uint8Array.from(bytes).buffer;
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": String(bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(_request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const segments = (await context.params).path;
  const ipfsPath = parseIpfsPath(segments.join("/"));
  if (!ipfsPath) return NextResponse.json({ error: "Invalid media CID." }, { status: 400 });

  const stored = await readStoredMedia(ipfsPath);
  if (stored) return imageResponse(stored, detectImageContentType(stored) as string);

  const urls = [...new Set(GATEWAY_BASES.map((base) => `${base.replace(/\/+$/, "")}/${ipfsPath}`))];
  try {
    const bytes = await Promise.any(urls.map(async (url) => {
      const response = await fetch(url, {
        headers: { Accept: "image/avif,image/webp,image/png,image/jpeg" },
        redirect: "error",
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
      return readLimitedImage(response);
    }));
    await storeMedia(ipfsPath, bytes).catch((error) => console.error("Could not cache IPFS media.", error));
    return imageResponse(bytes, detectImageContentType(bytes) as string);
  } catch {
    return NextResponse.json(
      { error: "Token image is temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "public, max-age=5, stale-if-error=300" } },
    );
  }
}
