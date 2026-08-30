import "server-only";

import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import { getAddress, isAddress, verifyMessage as verifyEoaMessage, type Address, type Hex } from "viem";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import { arcChain } from "@/lib/chains";
import {
  TOKEN_IMAGE_MAX_BYTES,
  canonicalMetadataCommitment,
  validateTokenMetadataInput,
  type TokenMetadataInput,
} from "@/lib/token-metadata";

const CHALLENGE_TTL_MS = 15 * 60 * 1_000;
const CHALLENGE_RATE_WINDOW_MS = 10 * 60 * 1_000;
const MAX_CHALLENGES_PER_WINDOW = 12;
const MAX_RATE_ENTRIES = 2_000;
const MAX_SIGNATURE_BYTES = 4_096;
const PINATA_V3_UPLOAD_URL = process.env.NODE_ENV === "production"
  ? "https://uploads.pinata.cloud/v3/files"
  : process.env.PINATA_UPLOAD_URL ?? "https://uploads.pinata.cloud/v3/files";
const PINATA_LEGACY_UPLOAD_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";

type Challenge = {
  address: Address;
  commitment: Hex;
  message: string;
  expiresAt: number;
};

type RateEntry = { startedAt: number; count: number };
type UploadState = {
  challenges: Map<string, Challenge>;
  rates: Map<string, RateEntry>;
};

declare global {
  var __arcOriginMetadataUploadState: UploadState | undefined;
}

const state = globalThis.__arcOriginMetadataUploadState ?? {
  challenges: new Map(),
  rates: new Map(),
};
globalThis.__arcOriginMetadataUploadState = state;
const signaturePublicClient = createArcPublicClient(
  process.env.ARC_MAINNET_RPC_URL,
  6_000,
);

export class MetadataUploadError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function metadataUploadAvailable() {
  return Boolean(process.env.PINATA_JWT?.trim());
}

function consumeRate(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  if (state.rates.size >= MAX_RATE_ENTRIES && !state.rates.has(key)) {
    for (const [rateKey, rate] of state.rates) {
      if (now - rate.startedAt >= CHALLENGE_RATE_WINDOW_MS) state.rates.delete(rateKey);
    }
    if (state.rates.size >= MAX_RATE_ENTRIES) {
      const oldestKey = state.rates.keys().next().value as string | undefined;
      if (oldestKey) state.rates.delete(oldestKey);
    }
  }
  const entry = state.rates.get(key);
  if (!entry || now - entry.startedAt >= windowMs) {
    state.rates.set(key, { startedAt: now, count: 1 });
    return;
  }
  if (entry.count >= limit) {
    const retryInSeconds = Math.max(1, Math.ceil((windowMs - (now - entry.startedAt)) / 1_000));
    throw new MetadataUploadError(
      `Upload rate limit reached. Try again in about ${Math.ceil(retryInSeconds / 60)} minute${retryInSeconds > 60 ? "s" : ""}.`,
      429,
    );
  }
  entry.count += 1;
}

function cleanupChallenges() {
  const now = Date.now();
  for (const [nonce, challenge] of state.challenges) {
    if (challenge.expiresAt <= now) state.challenges.delete(nonce);
  }
  if (state.challenges.size > 500) {
    const oldest = state.challenges.keys().next().value as string | undefined;
    if (oldest) state.challenges.delete(oldest);
  }
}

export function createMetadataChallenge(rawAddress: string, rawCommitment: string, clientKey: string) {
  if (!metadataUploadAvailable()) throw new MetadataUploadError("Token media storage is not configured yet.", 503);
  if (!isAddress(rawAddress)) throw new MetadataUploadError("Connect a valid wallet before uploading metadata.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(rawCommitment)) throw new MetadataUploadError("Invalid metadata commitment.");
  consumeRate(`challenge:${clientKey}`, MAX_CHALLENGES_PER_WINDOW, CHALLENGE_RATE_WINDOW_MS);
  cleanupChallenges();

  const address = getAddress(rawAddress);
  const commitment = rawCommitment.toLowerCase() as Hex;
  const nonce = randomBytes(18).toString("hex");
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  const message = [
    "ArcOrigin token metadata upload",
    `Network: ${arcChain.name} (${arcChain.id})`,
    `Wallet: ${address}`,
    `Metadata: ${commitment}`,
    `Nonce: ${nonce}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
    "This signature authorizes one public IPFS upload and no blockchain transaction.",
  ].join("\n");
  state.challenges.set(nonce, { address, commitment, message, expiresAt });
  return { nonce, message, expiresAt };
}

export async function authorizeMetadataUpload({
  nonce,
  address,
  commitment,
  signature,
}: {
  nonce: string;
  address: string;
  commitment: string;
  signature: string;
}) {
  cleanupChallenges();
  const challenge = state.challenges.get(nonce);
  if (!challenge || challenge.expiresAt <= Date.now()) throw new MetadataUploadError("Upload authorization expired. Sign again.", 401);
  if (!isAddress(address) || getAddress(address) !== challenge.address) throw new MetadataUploadError("Upload wallet does not match the signature.", 401);
  if (commitment.toLowerCase() !== challenge.commitment) throw new MetadataUploadError("Token metadata changed after signing.", 401);
  if (
    !/^0x[0-9a-fA-F]+$/.test(signature) ||
    (signature.length - 2) % 2 !== 0 ||
    (signature.length - 2) / 2 > MAX_SIGNATURE_BYTES
  ) throw new MetadataUploadError("Invalid wallet signature.", 401);

  let valid = false;
  try {
    valid = await verifyEoaMessage({
      address: challenge.address,
      message: challenge.message,
      signature: signature as Hex,
    });
  } catch {
    // Contract-wallet signatures are not ECDSA recoverable and are checked below.
  }
  if (!valid) {
    try {
      valid = await signaturePublicClient.verifyMessage({
        address: challenge.address,
        message: challenge.message,
        signature: signature as Hex,
      });
    } catch {
      throw new MetadataUploadError(
        "Smart-wallet signature verification is temporarily unavailable. Try again.",
        503,
      );
    }
  }
  if (!valid) throw new MetadataUploadError("Wallet signature could not be verified.", 401);

  state.challenges.delete(nonce);
  return challenge.address;
}

export function sha256Hex(bytes: Uint8Array) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

export function calculateMetadataCommitment(input: TokenMetadataInput, imageSha256: string) {
  const normalized = validateTokenMetadataInput(input);
  return `0x${createHash("sha256").update(canonicalMetadataCommitment(normalized, imageSha256)).digest("hex")}` as Hex;
}

export function validateImage(file: File | null, bytes: Uint8Array | null) {
  if (!file || !bytes) return;
  if (file.size <= 0 || file.size > TOKEN_IMAGE_MAX_BYTES) throw new MetadataUploadError("Optimized image must be 2 MB or smaller.");
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new MetadataUploadError("Use a PNG, JPG, or WebP image.");
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const webp = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!(jpeg || png || webp)) throw new MetadataUploadError("The uploaded file is not a valid PNG, JPG, or WebP image.");
}

export async function normalizeUploadedImage(bytes: Uint8Array) {
  try {
    const output = await sharp(bytes, { failOn: "warning", limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 84, effort: 4 })
      .toBuffer();
    if (output.length <= 0 || output.length > TOKEN_IMAGE_MAX_BYTES) {
      throw new MetadataUploadError("The normalized image is larger than 2 MB.");
    }
    return new File([output], "token-image.webp", { type: "image/webp" });
  } catch (error) {
    if (error instanceof MetadataUploadError) throw error;
    throw new MetadataUploadError("The image could not be safely decoded.");
  }
}

function safeFileStem(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "token";
}

async function uploadToPinata(file: File, displayName: string) {
  const jwt = process.env.PINATA_JWT?.trim();
  if (!jwt) throw new MetadataUploadError("Token media storage is not configured yet.", 503);

  const v3Body = new FormData();
  v3Body.append("file", file);
  v3Body.append("network", "public");
  v3Body.append("name", displayName);
  const v3Response = await requestPinata(PINATA_V3_UPLOAD_URL, v3Body, jwt);
  const v3Payload = await readJson(v3Response) as { data?: { cid?: unknown } } | null;
  const v3Cid = typeof v3Payload?.data?.cid === "string" ? v3Payload.data.cid : "";
  if (v3Response.ok) {
    if (validCid(v3Cid)) return v3Cid;
    console.error("Pinata V3 returned a successful response without a valid CID.");
    throw new MetadataUploadError("IPFS storage returned an invalid response. Try again.", 502);
  }

  // Pinata's V3 Files API requires the org:files:write scope. Existing Pinata
  // keys can instead be scoped to the still-supported pinFileToIPFS endpoint.
  // Fall back only for an authorization mismatch so quota and provider errors
  // are not hidden or retried as a duplicate upload.
  if (v3Response.status === 401 || v3Response.status === 403) {
    const legacyBody = new FormData();
    legacyBody.append("file", file);
    legacyBody.append("pinataMetadata", JSON.stringify({ name: displayName }));
    legacyBody.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
    const legacyResponse = await requestPinata(PINATA_LEGACY_UPLOAD_URL, legacyBody, jwt);
    const legacyPayload = await readJson(legacyResponse) as { IpfsHash?: unknown } | null;
    const legacyCid = typeof legacyPayload?.IpfsHash === "string" ? legacyPayload.IpfsHash : "";
    if (legacyResponse.ok) {
      if (validCid(legacyCid)) return legacyCid;
      console.error("Pinata legacy upload returned a successful response without a valid CID.");
      throw new MetadataUploadError("IPFS storage returned an invalid response. Try again.", 502);
    }
    console.error("Pinata upload authorization failed.", { v3Status: v3Response.status, legacyStatus: legacyResponse.status });
    throw pinataResponseError(legacyResponse.status);
  }

  console.error("Pinata V3 upload failed.", { status: v3Response.status });
  throw pinataResponseError(v3Response.status);
}

async function requestPinata(url: string, body: FormData, jwt: string) {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}` },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new MetadataUploadError("IPFS upload timed out. Try again.", 502);
  }
}

async function readJson(response: Response) {
  return response.json().catch(() => null) as Promise<unknown>;
}

function validCid(value: string) {
  return /^[A-Za-z0-9]{40,120}$/.test(value);
}

function pinataResponseError(status: number) {
  if (status === 401 || status === 403) {
    return new MetadataUploadError("IPFS credentials are invalid or missing upload permission. Update PINATA_JWT and retry.", 503);
  }
  if (status === 402 || status === 429) {
    return new MetadataUploadError("IPFS storage quota or rate limit was reached. Check the Pinata account and retry.", 503);
  }
  if (status === 413) return new MetadataUploadError("IPFS storage rejected the file because it is too large.", 413);
  if (status === 415 || status === 422) {
    return new MetadataUploadError("IPFS storage rejected this file type. Use PNG, JPG, or WebP.", 422);
  }
  if (status >= 500) return new MetadataUploadError("IPFS storage is temporarily unavailable. Try again.", 502);
  return new MetadataUploadError("IPFS storage rejected the upload. Try again.", 502);
}

export async function publishTokenMetadata({
  input,
  creator,
  image,
}: {
  input: TokenMetadataInput;
  creator: Address;
  image: File | null;
}) {
  const normalized = validateTokenMetadataInput(input);
  const stem = safeFileStem(`${normalized.name}-${normalized.symbol}`);
  let imageURI = "";
  if (image) {
    const extension = image.type === "image/png" ? "png" : image.type === "image/jpeg" ? "jpg" : "webp";
    const imageCid = await uploadToPinata(image, `${stem}.${extension}`);
    imageURI = `ipfs://${imageCid}`;
  }
  const metadata = {
    name: normalized.name,
    symbol: normalized.symbol,
    description: normalized.description,
    ...(imageURI ? { image: imageURI } : {}),
    ...(normalized.website ? { external_url: normalized.website } : {}),
    attributes: [
      { trait_type: "Network", value: arcChain.name },
      { trait_type: "Launchpad", value: "ArcOrigin" },
    ],
    properties: {
      creator,
      standard: "ArcOrigin Token Metadata v1",
      ...(normalized.website ? { website: normalized.website } : {}),
      ...(normalized.x ? { x: normalized.x } : {}),
      ...(normalized.telegram ? { telegram: normalized.telegram } : {}),
    },
  };
  const metadataFile = new File([JSON.stringify(metadata)], `${stem}.json`, { type: "application/json" });
  const metadataCid = await uploadToPinata(metadataFile, `${stem}.json`);
  return {
    metadataURI: `ipfs://${metadataCid}`,
    imageURI,
    gatewayURL: `https://gateway.pinata.cloud/ipfs/${metadataCid}`,
  };
}
