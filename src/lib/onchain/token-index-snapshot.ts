import "server-only";

import { formatUnits, type Address, type Hash } from "viem";
import {
  ARCORIGIN_CROSS_MARKET_CAP_USDC,
  ARCORIGIN_NETWORK,
  ARCORIGIN_START_MARKET_CAP_USDC,
  ARC_ACTIVE_FACTORY,
  arcChain,
} from "@/lib/chains";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import {
  createCanonicalCheckpoint,
  getCanonicalCheckpointStatus,
  upgradeLegacyCanonicalCheckpoint,
} from "@/lib/onchain/canonical-checkpoint";
import { getFactoryLaunchIndex, type FactoryLaunch } from "@/lib/onchain/holder-snapshot";
import { calculateRiskScore } from "@/lib/scoring";
import { factoryAbi } from "@/lib/contracts";
import { resolveTokenMetadata } from "@/lib/server/token-metadata-resolver";
import { readPersistentSnapshot, writePersistentSnapshot } from "@/lib/server/persistent-cache";
import type { CreatorProfile, TokenData } from "@/lib/types";

const tokenConfigAbi = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "metadataURI", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const CACHE_TTL_MS = 30_000;
const MIN_REFRESH_INTERVAL_MS = 10_000;
const FORCE_REFRESH_INTERVAL_MS = 1_500;
const REQUEST_WAIT_TIMEOUT_MS = 10_000;
const PERSISTENT_CACHE_KEY = `arcorigin:${ARCORIGIN_NETWORK}:token-index:${ARC_ACTIVE_FACTORY.toLowerCase()}`;
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const TOKEN_INDEX_SCHEMA_VERSION = 2;

type TokenIndexSnapshot = {
  schemaVersion: number;
  tokens: TokenData[];
  indexedBlock: string;
  indexedBlockHash?: Hash;
  generatedAt: string;
};

type TokenIndexState = {
  snapshot: TokenIndexSnapshot | null;
  cachedAt: number;
  lastAttemptAt: number;
  pending: Promise<TokenIndexSnapshot> | null;
  hydratedTokens: Map<string, TokenData>;
  canonicalCheckedAt: number;
};

const publicClient = createArcPublicClient(
  ARCORIGIN_NETWORK === "mainnet" ? process.env.ARC_MAINNET_RPC_URL : process.env.ARC_TESTNET_RPC_URL,
  8_000,
);

declare global {
  var __arcOriginTokenIndexState: TokenIndexState | undefined;
}

const state = globalThis.__arcOriginTokenIndexState ?? {
  snapshot: null,
  cachedAt: 0,
  lastAttemptAt: 0,
  pending: null,
  hydratedTokens: new Map(),
  canonicalCheckedAt: 0,
};
globalThis.__arcOriginTokenIndexState = state;

function readCanonicalBlock(blockNumber: bigint) {
  return publicClient.getBlock({ blockNumber });
}

function isUsableSnapshot(snapshot: TokenIndexSnapshot | null): snapshot is TokenIndexSnapshot {
  return Boolean(
    snapshot
    && snapshot.schemaVersion === TOKEN_INDEX_SCHEMA_VERSION
    && Array.isArray(snapshot.tokens)
    && snapshot.tokens.every((token) => typeof token.automaticBuyback === "boolean")
    && typeof snapshot.generatedAt === "string",
  );
}

export async function getCachedTokenIndexSnapshot() {
  if (isUsableSnapshot(state.snapshot)) return state.snapshot;
  const persisted = await readPersistentSnapshot<TokenIndexSnapshot>(PERSISTENT_CACHE_KEY);
  return isUsableSnapshot(persisted) ? persisted : null;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForSnapshot(pending: Promise<TokenIndexSnapshot>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Arc RPC request timed out.")), REQUEST_WAIT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isRetryableRpcError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /RPC Request failed|HTTP request failed|fetch failed|Too Many Requests|rate limit|request limit|\b429\b|timed? ?out|socket/i.test(message);
}

async function withRpcRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableRpcError(error) || attempt === attempts) throw error;
      await wait(attempt * 1_500);
    }
  }
  throw new Error("Arc RPC request failed after retries.");
}

function iconFor(name: string, symbol: string) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join("");
  return (initials || symbol.slice(0, 2) || "T").toUpperCase();
}

async function hydrateLaunch(launch: FactoryLaunch, creatorLaunches: number) {
  const cacheKey = launch.token.toLowerCase();
  const cached = state.hydratedTokens.get(cacheKey);
  if (cached) {
    const metadata = cached.metadataURI ? await resolveTokenMetadata(cached.metadataURI) : null;
    const refreshed = {
      ...cached,
      launchedAt: launch.launchedAt,
      ageMinutes: Math.max(0, Math.floor((Date.now() / 1_000 - launch.launchedAt) / 60)),
      image: metadata?.image ?? cached.image,
      description: metadata?.description ?? cached.description,
      socials: {
        website: metadata?.website ?? cached.socials.website,
        x: metadata?.x ?? cached.socials.x,
        telegram: metadata?.telegram ?? cached.socials.telegram,
      },
      creatorProfile: { ...cached.creatorProfile, launches: creatorLaunches },
    } satisfies TokenData;
    state.hydratedTokens.set(cacheKey, refreshed);
    return refreshed;
  }

  const [totalSupplyRaw, metadataURI, tokenInfo] = await withRpcRetry(() => publicClient.multicall({
    allowFailure: false,
    multicallAddress: MULTICALL3_ADDRESS,
    contracts: [
      { address: launch.token, abi: tokenConfigAbi, functionName: "totalSupply" },
      { address: launch.token, abi: tokenConfigAbi, functionName: "metadataURI" },
      { address: launch.factory, abi: factoryAbi, functionName: "getTokenInfo", args: [launch.token] },
    ],
  }));
  if (tokenInfo.token.toLowerCase() !== launch.token.toLowerCase() || tokenInfo.pool.toLowerCase() !== launch.pool.toLowerCase()) {
    throw new Error("Factory token record does not match the indexed launch.");
  }
  const metadata = await resolveTokenMetadata(metadataURI);
  const totalSupply = Number(formatUnits(totalSupplyRaw, 18));
  if (totalSupply <= 0) throw new Error("Factory token supply is invalid.");
  const launchPrice = ARCORIGIN_START_MARKET_CAP_USDC / totalSupply;
  const risk = calculateRiskScore({
    fixedSupply: true,
    standardTemplate: true,
    noBlacklist: true,
    noHiddenMint: true,
    creatorAllocationPercent: 0,
    socialsPresent: Boolean(metadata?.website || metadata?.x),
    verifiedTemplate: true,
    holderConcentrationKnown: true,
    topTenHolderPercent: 0,
    previousCleanLaunches: 0,
  });
  const creatorProfile: CreatorProfile = {
    address: launch.creator,
    reputation: creatorLaunches > 1 ? 55 : 50,
    launches: creatorLaunches,
    crossed: 0,
    flagged: 0,
    totalVolume: 0,
    totalFees: 10,
    verified: false,
  };
  const token: TokenData = {
    name: launch.name,
    ticker: launch.symbol,
    icon: iconFor(launch.name, launch.symbol),
    image: metadata?.image,
    metadataURI,
    address: launch.token,
    poolAddress: launch.pool,
    positionId: launch.positionId.toString(),
    factoryAddress: launch.factory,
    automaticBuyback: tokenInfo.automaticBuyback,
    creator: launch.creator,
    source: "onchain",
    creatorAllocationPercent: 0,
    launchTxHash: launch.transactionHash,
    launchBlock: Number(launch.launchBlock),
    launchedAt: launch.launchedAt,
    totalSupply,
    description: metadata?.description ?? `ArcOrigin launch indexed from ${arcChain.name} Uniswap V3 events.`,
    ageMinutes: Math.max(0, Math.floor((Date.now() / 1_000 - launch.launchedAt) / 60)),
    price: launchPrice,
    priceChange24h: 0,
    marketCap: ARCORIGIN_START_MARKET_CAP_USDC,
    raisedUSDC: ARCORIGIN_START_MARKET_CAP_USDC,
    targetUSDC: ARCORIGIN_CROSS_MARKET_CAP_USDC,
    volume5m: 0,
    volume1h: 0,
    volume24h: 0,
    buyers: 0,
    sellers: 0,
    trades: 0,
    holders: 0,
    crossProgress: ARCORIGIN_START_MARKET_CAP_USDC / ARCORIGIN_CROSS_MARKET_CAP_USDC * 100,
    riskScore: risk.score,
    status: "Live",
    chartData: [{ time: "Launch", timestamp: launch.launchedAt, price: launchPrice, volume: 0 }],
    recentTrades: [],
    riskLabels: risk.labels,
    creatorProfile,
    socials: { website: metadata?.website, x: metadata?.x, telegram: metadata?.telegram },
  };
  state.hydratedTokens.set(cacheKey, token);
  return token;
}

async function loadTokenIndex(forceRefresh: boolean): Promise<TokenIndexSnapshot> {
  const { launches, indexedBlock } = await getFactoryLaunchIndex(forceRefresh);
  const checkpoint = await createCanonicalCheckpoint(indexedBlock, readCanonicalBlock);
  const activeLaunches = launches.filter((launch) => launch.factory.toLowerCase() === ARC_ACTIVE_FACTORY.toLowerCase());
  const creatorCounts = new Map<string, number>();
  for (const launch of activeLaunches) {
    const creator = launch.creator.toLowerCase();
    creatorCounts.set(creator, (creatorCounts.get(creator) ?? 0) + 1);
  }
  const tokens: TokenData[] = [];
  const launchesNewestFirst = activeLaunches.slice().reverse();
  for (let index = 0; index < launchesNewestFirst.length; index += 2) {
    tokens.push(...await Promise.all(launchesNewestFirst.slice(index, index + 2).map((launch) => hydrateLaunch(
      launch,
      creatorCounts.get(launch.creator.toLowerCase()) ?? 1,
    ))));
  }
  return { schemaVersion: TOKEN_INDEX_SCHEMA_VERSION, tokens, ...checkpoint, generatedAt: new Date().toISOString() };
}

export async function getTokenIndexSnapshot(forceRefresh = false) {
  if (!state.snapshot) {
    let persisted = await readPersistentSnapshot<TokenIndexSnapshot>(PERSISTENT_CACHE_KEY);
    const upgraded = await upgradeLegacyCanonicalCheckpoint(persisted, readCanonicalBlock);
    if (upgraded) {
      persisted = upgraded;
      void writePersistentSnapshot(PERSISTENT_CACHE_KEY, upgraded);
    }
    const checkpointStatus = persisted ? await getCanonicalCheckpointStatus(persisted, readCanonicalBlock) : "invalid";
    if (isUsableSnapshot(persisted) && (checkpointStatus === "canonical" || checkpointStatus === "unavailable")) {
      state.snapshot = persisted;
      state.cachedAt = Date.parse(persisted.generatedAt) || 0;
      state.canonicalCheckedAt = Date.now();
    }
  }
  const now = Date.now();
  if (state.snapshot && now - state.canonicalCheckedAt >= MIN_REFRESH_INTERVAL_MS) {
    const checkpointStatus = await getCanonicalCheckpointStatus(state.snapshot, readCanonicalBlock);
    state.canonicalCheckedAt = now;
    if (checkpointStatus === "orphaned" || checkpointStatus === "invalid") {
      state.snapshot = null;
      state.cachedAt = 0;
      state.hydratedTokens.clear();
    }
  }
  const isFresh = state.snapshot && now - state.cachedAt < CACHE_TTL_MS;
  const refreshThrottled = state.snapshot && now - state.lastAttemptAt < (forceRefresh ? FORCE_REFRESH_INTERVAL_MS : MIN_REFRESH_INTERVAL_MS);
  if (isFresh && !forceRefresh) return { snapshot: state.snapshot, stale: false };
  if (refreshThrottled) return { snapshot: state.snapshot, stale: now - state.cachedAt >= CACHE_TTL_MS };
  if (!state.snapshot && !state.pending && state.lastAttemptAt > 0 && now - state.lastAttemptAt < MIN_REFRESH_INTERVAL_MS) {
    throw new Error("Arc RPC rate limit cooldown is active.");
  }
  if (!state.pending) {
    state.lastAttemptAt = now;
    state.pending = loadTokenIndex(forceRefresh).then((snapshot) => {
      state.snapshot = snapshot;
      state.cachedAt = Date.now();
      state.canonicalCheckedAt = Date.now();
      void writePersistentSnapshot(PERSISTENT_CACHE_KEY, snapshot);
      return snapshot;
    }).finally(() => { state.pending = null; });
  }
  if (state.snapshot && !forceRefresh) {
    void state.pending?.catch(() => undefined);
    return { snapshot: state.snapshot, stale: true };
  }
  try {
    return { snapshot: await waitForSnapshot(state.pending), stale: false };
  } catch (error) {
    if (state.snapshot) return { snapshot: state.snapshot, stale: true };
    throw error;
  }
}

export async function getTokenIndexSnapshotForToken(tokenAddress: Address, forceRefresh = false) {
  const containsToken = (result: Awaited<ReturnType<typeof getTokenIndexSnapshot>>) => result.snapshot?.tokens.some(
    (token) => token.address.toLowerCase() === tokenAddress.toLowerCase(),
  );
  let result = await getTokenIndexSnapshot(forceRefresh);
  if (containsToken(result)) return result;
  if (!forceRefresh) {
    result = await getTokenIndexSnapshot(true);
    if (containsToken(result)) return result;
  }
  const remainingCooldown = FORCE_REFRESH_INTERVAL_MS - (Date.now() - state.lastAttemptAt);
  if (remainingCooldown > 0) await wait(remainingCooldown + 50);
  return getTokenIndexSnapshot(true);
}

export function isTokenIndexRpcError(error: unknown) {
  return isRetryableRpcError(error);
}

export async function getTokenIndexCacheStatus() {
  let snapshot = state.snapshot ?? await readPersistentSnapshot<TokenIndexSnapshot>(PERSISTENT_CACHE_KEY);
  const upgraded = await upgradeLegacyCanonicalCheckpoint(snapshot, readCanonicalBlock);
  if (upgraded) {
    snapshot = upgraded;
    state.snapshot = upgraded;
    state.cachedAt = Date.parse(upgraded.generatedAt) || 0;
    state.canonicalCheckedAt = Date.now();
    void writePersistentSnapshot(PERSISTENT_CACHE_KEY, upgraded);
  }
  if (!snapshot) return { available: false, indexedBlock: null, ageSeconds: null, checkpoint: "missing" as const, tokenCount: 0 };
  const checkpoint = await getCanonicalCheckpointStatus(snapshot, readCanonicalBlock);
  const generatedAt = Date.parse(snapshot.generatedAt);
  return {
    available: true,
    indexedBlock: snapshot.indexedBlock,
    ageSeconds: Number.isFinite(generatedAt) ? Math.max(0, Math.floor((Date.now() - generatedAt) / 1_000)) : null,
    checkpoint,
    tokenCount: snapshot.tokens.length,
  };
}
