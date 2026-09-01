import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseIpfsPath } from "@/lib/ipfs";

export const MAX_MEDIA_BYTES = 2 * 1024 * 1024;
const MEDIA_STORAGE_DIR = process.env.ARCORIGIN_MEDIA_STORAGE_DIR?.trim()
  || (process.env.NODE_ENV === "production" ? "/var/lib/arcorigin/media" : path.join(process.cwd(), ".data", "media"));

function storagePath(ipfsPath: string) {
  const normalized = parseIpfsPath(ipfsPath);
  if (!normalized) throw new Error("Invalid IPFS media path.");
  return path.join(MEDIA_STORAGE_DIR, createHash("sha256").update(normalized).digest("hex"));
}

export function detectImageContentType(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) return "image/webp";
  return null;
}

export async function readStoredMedia(ipfsPath: string) {
  try {
    const bytes = await readFile(storagePath(ipfsPath));
    if (bytes.length <= 0 || bytes.length > MAX_MEDIA_BYTES || !detectImageContentType(bytes)) return null;
    return bytes;
  } catch {
    return null;
  }
}

export async function storeMedia(ipfsPath: string, bytes: Uint8Array) {
  if (bytes.length <= 0 || bytes.length > MAX_MEDIA_BYTES || !detectImageContentType(bytes)) {
    throw new Error("Only valid PNG, JPG, or WebP media can be stored.");
  }
  await mkdir(MEDIA_STORAGE_DIR, { recursive: true, mode: 0o750 });
  const destination = storagePath(ipfsPath);
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o640 });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
