import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseIpfsPath } from "@/lib/ipfs";

const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const STORAGE_DIR = process.env.ARCORIGIN_METADATA_STORAGE_DIR?.trim()
  || (process.env.NODE_ENV === "production" ? "/var/lib/arcorigin/metadata" : path.join(process.cwd(), ".data", "metadata"));

function storagePath(ipfsPath: string) {
  const normalized = parseIpfsPath(ipfsPath);
  if (!normalized) throw new Error("Invalid IPFS metadata path.");
  return path.join(STORAGE_DIR, createHash("sha256").update(normalized).digest("hex"));
}

export async function readStoredTokenMetadata(ipfsPath: string) {
  try {
    const bytes = await readFile(storagePath(ipfsPath));
    if (bytes.length <= 0 || bytes.length > MAX_METADATA_BYTES) return null;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function storeTokenMetadata(ipfsPath: string, metadata: Record<string, unknown>) {
  const bytes = Buffer.from(JSON.stringify(metadata));
  if (bytes.length <= 0 || bytes.length > MAX_METADATA_BYTES) throw new Error("Token metadata is too large.");
  await mkdir(STORAGE_DIR, { recursive: true, mode: 0o750 });
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
