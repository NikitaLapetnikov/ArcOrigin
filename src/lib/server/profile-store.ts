import "server-only";

import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";
import { readPersistentSnapshot, writePersistentSnapshot } from "@/lib/server/persistent-cache";

const PROFILE_TTL_SECONDS = 5 * 365 * 24 * 60 * 60;
const CHALLENGE_TTL_MS = 5 * 60 * 1_000;
const RATE_WINDOW_MS = 60 * 60 * 1_000;
const MAX_UPDATES_PER_WINDOW = 12;
const MAX_AVATAR_BYTES = 350_000;
const MAX_RATE_ENTRIES = 2_000;

type Challenge = {
  address: Address;
  commitment: Hex;
  message: string;
  expiresAt: number;
};

type RateEntry = { startedAt: number; count: number };
type ProfileState = {
  challenges: Map<string, Challenge>;
  rates: Map<string, RateEntry>;
};

export type PublicWalletProfile = {
  address: Address;
  username: string;
  avatar: string;
  updatedAt: string;
};

declare global {
  var __arcOriginProfileState: ProfileState | undefined;
}

const state = globalThis.__arcOriginProfileState ?? {
  challenges: new Map(),
  rates: new Map(),
};
globalThis.__arcOriginProfileState = state;

export class ProfileError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function normalizeUsername(value: string) {
  const username = value.trim().toLowerCase();
  if (username && !/^[a-z0-9_]{3,20}$/.test(username)) {
    throw new ProfileError("Username must contain 3–20 lowercase letters, numbers, or underscores.");
  }
  return username;
}

export function profileCommitment(username: string, imageHash: string, removeAvatar: boolean) {
  const normalized = normalizeUsername(username);
  if (imageHash && !/^0x[0-9a-fA-F]{64}$/.test(imageHash)) throw new ProfileError("Invalid avatar commitment.");
  return `0x${createHash("sha256")
    .update(JSON.stringify({ username: normalized, imageHash: imageHash.toLowerCase(), removeAvatar }))
    .digest("hex")}` as Hex;
}

export function profileImageHash(bytes: Uint8Array | null) {
  return bytes ? `0x${createHash("sha256").update(bytes).digest("hex")}` : "";
}

export function createProfileChallenge(rawAddress: string, rawCommitment: string, clientKey: string) {
  if (!isAddress(rawAddress)) throw new ProfileError("Connect a valid wallet before editing the profile.");
  if (!/^0x[0-9a-fA-F]{64}$/.test(rawCommitment)) throw new ProfileError("Invalid profile commitment.");
  cleanupChallenges();
  consumeRate(`challenge:${clientKey}`, 30);

  const address = getAddress(rawAddress);
  const commitment = rawCommitment.toLowerCase() as Hex;
  const nonce = randomBytes(18).toString("hex");
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  const message = [
    "ArcOrigin profile update",
    `Wallet: ${address}`,
    `Profile: ${commitment}`,
    `Nonce: ${nonce}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
    "This signature updates your public ArcOrigin profile and does not create a blockchain transaction.",
  ].join("\n");
  state.challenges.set(nonce, { address, commitment, message, expiresAt });
  return { nonce, message, expiresAt };
}

export async function authorizeProfileUpdate({
  nonce,
  address,
  commitment,
  signature,
  clientKey,
}: {
  nonce: string;
  address: string;
  commitment: string;
  signature: string;
  clientKey: string;
}) {
  cleanupChallenges();
  const challenge = state.challenges.get(nonce);
  if (!challenge || challenge.expiresAt <= Date.now()) throw new ProfileError("Profile authorization expired. Sign again.", 401);
  if (!isAddress(address) || getAddress(address) !== challenge.address) throw new ProfileError("Wallet does not match the profile signature.", 401);
  if (commitment.toLowerCase() !== challenge.commitment) throw new ProfileError("Profile changed after signing.", 401);
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new ProfileError("Invalid wallet signature.", 401);
  const valid = await verifyMessage({
    address: challenge.address,
    message: challenge.message,
    signature: signature as Hex,
  });
  if (!valid) throw new ProfileError("Wallet signature could not be verified.", 401);

  state.challenges.delete(nonce);
  consumeRate(`update:wallet:${challenge.address.toLowerCase()}`, MAX_UPDATES_PER_WINDOW);
  consumeRate(`update:client:${clientKey}`, MAX_UPDATES_PER_WINDOW);
  return challenge.address;
}

export async function normalizeProfileAvatar(file: File | null, bytes: Uint8Array | null) {
  if (!file || !bytes) return "";
  if (file.size <= 0 || file.size > MAX_AVATAR_BYTES) throw new ProfileError("Optimized avatar must be 350 KB or smaller.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new ProfileError("Use a PNG, JPG, or WebP avatar.");
  try {
    const output = await sharp(bytes, { failOn: "warning", limitInputPixels: 20_000_000 })
      .rotate()
      .resize(384, 384, { fit: "cover", position: "centre" })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
    if (output.length > MAX_AVATAR_BYTES) throw new ProfileError("The optimized avatar is too large.");
    return `data:image/webp;base64,${output.toString("base64")}`;
  } catch (error) {
    if (error instanceof ProfileError) throw error;
    throw new ProfileError("The avatar could not be safely decoded.");
  }
}

export async function readWalletProfile(rawAddress: string) {
  if (!isAddress(rawAddress)) throw new ProfileError("Invalid wallet address.");
  return readPersistentSnapshot<PublicWalletProfile>(profileKey(getAddress(rawAddress)));
}

export async function saveWalletProfile({
  address,
  username,
  avatar,
  removeAvatar,
}: {
  address: Address;
  username: string;
  avatar: string;
  removeAvatar: boolean;
}) {
  const existing = await readWalletProfile(address);
  const profile: PublicWalletProfile = {
    address,
    username: normalizeUsername(username),
    avatar: removeAvatar ? "" : avatar || existing?.avatar || "",
    updatedAt: new Date().toISOString(),
  };
  const saved = await writePersistentSnapshot(profileKey(address), profile, PROFILE_TTL_SECONDS);
  if (!saved) throw new ProfileError("Profile storage is temporarily unavailable. Try again later.", 503);
  return profile;
}

function profileKey(address: Address) {
  return `arcorigin:profile:v1:${address.toLowerCase()}`;
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

function consumeRate(key: string, limit: number) {
  const now = Date.now();
  if (state.rates.size >= MAX_RATE_ENTRIES && !state.rates.has(key)) {
    for (const [rateKey, rate] of state.rates) {
      if (now - rate.startedAt >= RATE_WINDOW_MS) state.rates.delete(rateKey);
    }
    if (state.rates.size >= MAX_RATE_ENTRIES) {
      const oldestKey = state.rates.keys().next().value as string | undefined;
      if (oldestKey) state.rates.delete(oldestKey);
    }
  }
  const current = state.rates.get(key);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    state.rates.set(key, { startedAt: now, count: 1 });
    return;
  }
  if (current.count >= limit) throw new ProfileError("Profile update rate limit reached. Try again later.", 429);
  current.count += 1;
}
