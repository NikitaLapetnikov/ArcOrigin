import "server-only";

import { formatUnits, type Address, type Hash } from "viem";
import {
  ARCORIGIN_NETWORK,
  ARCORIGIN_PROTOCOL_VERSION,
  ARC_ACTIVE_FACTORY,
  arcChain,
} from "@/lib/chains";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import {
  createCanonicalCheckpoint,
  getCanonicalCheckpointStatus,
  upgradeLegacyCanonicalCheckpoint,
} from "@/lib/onchain/canonical-checkpoint";
import { legacyGenesisToken } from "@/lib/onchain/legacy-genesis";
import { currentV4Tokens } from "@/lib/onchain/current-v4-token";
import { getFactoryLaunchIndex, type FactoryLaunch } from "@/lib/onchain/holder-snapshot";
import { getVerifiedBootstrapTokens } from "@/lib/onchain/verified-bootstrap-tokens";
import { calculateRiskScore } from "@/lib/scoring";
import { resolveTokenMetadata } from "@/lib/server/token-metadata-resolver";
import { readPersistentSnapshot, writePersistentSnapshot } from "@/lib/server/persistent-cache";
import type { CreatorProfile, TokenData } from "@/lib/types";

const tokenConfigAbi = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "metadataURI", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const curveConfigAbi = [
  { type: "function", name: "initialTokenReserve", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "virtualUsdcReserve", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "graduationThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const CACHE_TTL_MS = 30_000;
const MIN_REFRESH_INTERVAL_MS = 10_000;
const FORCE_REFRESH_INTERVAL_MS = 1_500;
const REQUEST_WAIT_TIMEOUT_MS = 10_000;
const PERSISTENT_CACHE_KEY =
  `arcorigin:${ARCORIGIN_NETWORK}:v${ARCORIGIN_PROTOCOL_VERSION}:token-index:${ARC_ACTIVE_FACTORY.toLowerCase()}`;
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

type TokenIndexSnapshot = {
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
  ARCORIGIN_NETWORK === "mainnet"
    ? process.env.ARC_MAINNET_RPC_URL
    : process.env.ARC_TESTNET_RPC_URL,
  8_000,
);
const verifiedV4Tokens = currentV4Tokens(getVerifiedBootstrapTokens());

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
state.canonicalCheckedAt ??= 0;
globalThis.__arcOriginTokenIndexState = state;

function readCanonicalBlock(blockNumber: bigint) {
  return publicClient.getBlock({ blockNumber });
}

function isUsableTokenIndexSnapshot(snapshot: TokenIndexSnapshot | null): snapshot is TokenIndexSnapshot {
  return Boolean(snapshot && Array.isArray(snapshot.tokens) && typeof snapshot.generatedAt === "string");
}

/** Returns the last confirmed snapshot without blocking the initial page on RPC. */
export async function getCachedTokenIndexSnapshot() {
  if (isUsableTokenIndexSnapshot(state.snapshot)) return state.snapshot;
  const persisted = await readPersistentSnapshot<TokenIndexSnapshot>(PERSISTENT_CACHE_KEY);
  if (isUsableTokenIndexSnapshot(persisted)) return persisted;
  if (verifiedV4Tokens.length === 0) return null;
  return {
    tokens: verifiedV4Tokens,
    indexedBlock: String(Math.max(...verifiedV4Tokens.map((token) => token.launchBlock ?? 0))),
    generatedAt: new Date().toISOString(),
  } satisfies TokenIndexSnapshot;
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
    const refreshedToken: TokenData = {
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
    };
    state.hydratedTokens.set(cacheKey, refreshedToken);
    return refreshedToken;
  }

  if (launch.token.toLowerCase() === legacyGenesisToken.address.toLowerCase()) {
    const token: TokenData = {
      ...legacyGenesisToken,
      name: launch.name,
      ticker: launch.symbol,
      address: launch.token,
      curveAddress: launch.curve,
      factoryAddress: launch.factory,
      creator: launch.creator,
      launchBlock: Number(launch.launchBlock),
      launchedAt: launch.launchedAt,
      ageMinutes: Math.max(0, Math.floor((Date.now() / 1_000 - launch.launchedAt) / 60)),
      launchTxHash: launch.transactionHash,
      holders: 0,
      creatorProfile: { ...legacyGenesisToken.creatorProfile, launches: creatorLaunches },
    };
    state.hydratedTokens.set(cacheKey, token);
    return token;
  }

  const [totalSupplyRaw, metadataURI, initialReserveRaw, virtualUsdcRaw, graduationRaw] = await withRpcRetry(
    () => publicClient.multicall({
      allowFailure: false,
      multicallAddress: MULTICALL3_ADDRESS,
      contracts: [
        { address: launch.token, abi: tokenConfigAbi, functionName: "totalSupply" },
        { address: launch.token, abi: tokenConfigAbi, functionName: "metadataURI" },
        { address: launch.curve, abi: curveConfigAbi, functionName: "initialTokenReserve" },
        { address: launch.curve, abi: curveConfigAbi, functionName: "virtualUsdcReserve" },
        { address: launch.curve, abi: curveConfigAbi, functionName: "graduationThreshold" },
      ],
    }),
  );
  const metadata = await resolveTokenMetadata(metadataURI);
  const totalSupply = Number(formatUnits(totalSupplyRaw, 18));
  const initialReserve = Number(formatUnits(initialReserveRaw, 18));
  const creatorAllocationPercent = totalSupply > 0 ? (totalSupply - initialReserve) / totalSupply * 100 : 0;
  const virtualUsdcReserve = Number(formatUnits(virtualUsdcRaw, 6));
  const targetUSDC = Number(formatUnits(graduationRaw, 6));
  if (totalSupply <= 0 || initialReserve <= 0 || targetUSDC <= 0) throw new Error("Factory token configuration is invalid.");
  const risk = calculateRiskScore({
    fixedSupply: true,
    standardTemplate: true,
    noBlacklist: true,
    noHiddenMint: true,
    creatorAllocationPercent,
    socialsPresent: Boolean(metadata?.website || metadata?.x),
    verifiedTemplate: true,
    holderConcentrationKnown: false,
    topTenHolderPercent: 100,
    previousCleanLaunches: 0,
  });
  const creatorProfile: CreatorProfile = {
    address: launch.creator,
    reputation: creatorLaunches > 1 ? 55 : 50,
    launches: creatorLaunches,
    graduated: 0,
    flagged: 0,
    totalVolume: 0,
    totalFees: 10,
    verified: false,
  };
  const launchPrice = virtualUsdcReserve / initialReserve;
  const token: TokenData = {
    name: launch.name,
    ticker: launch.symbol,
    icon: iconFor(launch.name, launch.symbol),
    image: metadata?.image,
    metadataURI,
    address: launch.token,
    curveAddress: launch.curve,
    factoryAddress: launch.factory,
    creator: launch.creator,
    source: "onchain",
    creatorAllocationPercent,
    launchTxHash: launch.transactionHash,
    launchBlock: Number(launch.launchBlock),
    launchedAt: launch.launchedAt,
    totalSupply,
    virtualUsdcReserve,
    description: metadata?.description ?? `ArcOrigin factory launch indexed from ${arcChain.name} events.`,
    ageMinutes: Math.max(0, Math.floor((Date.now() / 1_000 - launch.launchedAt) / 60)),
    price: launchPrice,
    priceChange24h: 0,
    marketCap: launchPrice * totalSupply,
    raisedUSDC: 0,
    targetUSDC,
    volume5m: 0,
    volume1h: 0,
    volume24h: 0,
    buyers: 0,
    sellers: 0,
    trades: 0,
    holders: 0,
    curveProgress: 0,
    riskScore: risk.score,
    status: "Live on curve",
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
  const activeLaunches = launches.filter(
    (launch) => launch.factory.toLowerCase() === ARC_ACTIVE_FACTORY.toLowerCase(),
  );
  if (activeLaunches.length === 0) {
    if (verifiedV4Tokens.length > 0) {
      throw new Error("The active Factory log source returned an unexpected empty snapshot.");
    }
    return {
      tokens: [],
      ...checkpoint,
      generatedAt: new Date().toISOString(),
    };
  }
  const creatorCounts = new Map<string, number>();
  for (const launch of activeLaunches) {
    const creator = launch.creator.toLowerCase();
    creatorCounts.set(creator, (creatorCounts.get(creator) ?? 0) + 1);
  }
  const reversedLaunches = activeLaunches.slice().reverse();
  const tokens: TokenData[] = [];
  for (let index = 0; index < reversedLaunches.length; index += 2) {
    tokens.push(...await Promise.all(reversedLaunches.slice(index, index + 2).map((launch) => hydrateLaunch(
      launch,
      creatorCounts.get(launch.creator.toLowerCase()) ?? 1,
    ))));
  }
  const currentTokens = currentV4Tokens(tokens);
  if (currentTokens.length === 0 && verifiedV4Tokens.length > 0) {
    throw new Error("The active Factory snapshot did not contain its confirmed launch.");
  }
  return {
    tokens: currentTokens,
    ...checkpoint,
    generatedAt: new Date().toISOString(),
  };
}

export async function getTokenIndexSnapshot(forceRefresh = false) {
  if (!state.snapshot) {
    let persisted = await readPersistentSnapshot<TokenIndexSnapshot>(PERSISTENT_CACHE_KEY);
    const upgraded = await upgradeLegacyCanonicalCheckpoint(persisted, readCanonicalBlock);
    if (upgraded) {
      persisted = upgraded;
      void writePersistentSnapshot(PERSISTENT_CACHE_KEY, upgraded);
    }
    const checkpointStatus = persisted
      ? await getCanonicalCheckpointStatus(persisted, readCanonicalBlock)
      : "invalid";
    if (
      persisted?.tokens
      && Array.isArray(persisted.tokens)
      && (persisted.tokens.length > 0 || verifiedV4Tokens.length === 0)
      && (checkpointStatus === "canonical" || checkpointStatus === "unavailable")
    ) {
      state.snapshot = persisted;
      state.cachedAt = Date.parse(persisted.generatedAt) || 0;
      state.canonicalCheckedAt = Date.now();
    } else if (verifiedV4Tokens.length > 0) {
      state.snapshot = {
        tokens: verifiedV4Tokens,
        indexedBlock: String(Math.max(...verifiedV4Tokens.map((token) => token.launchBlock ?? 0))),
        generatedAt: new Date().toISOString(),
      };
      state.cachedAt = 0;
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
  const refreshThrottled = state.snapshot
    && now - state.lastAttemptAt < (forceRefresh ? FORCE_REFRESH_INTERVAL_MS : MIN_REFRESH_INTERVAL_MS);
  if (isFresh && !forceRefresh) return { snapshot: state.snapshot, stale: false };
  if (refreshThrottled) return { snapshot: state.snapshot, stale: now - state.cachedAt >= CACHE_TTL_MS };
  if (!state.snapshot && !state.pending && state.lastAttemptAt > 0 && now - state.lastAttemptAt < MIN_REFRESH_INTERVAL_MS) {
    throw new Error("Arc RPC rate limit cooldown is active.");
  }
  if (!state.pending) {
    state.lastAttemptAt = now;
    state.pending = loadTokenIndex(forceRefresh)
      .then((snapshot) => {
        state.snapshot = snapshot;
        state.cachedAt = Date.now();
        state.canonicalCheckedAt = Date.now();
        void writePersistentSnapshot(PERSISTENT_CACHE_KEY, snapshot);
        return snapshot;
      })
      .finally(() => {
        state.pending = null;
      });
  }
  if (state.snapshot && !forceRefresh) {
    // The stale response is intentional, but the refresh continues after the
    // request returns. Observe failures so a provider outage cannot surface as
    // an unhandled rejection in the server process.
    void state.pending?.catch(() => undefined);
    return { snapshot: state.snapshot, stale: true };
  }
  try {
    const snapshot = await waitForSnapshot(state.pending);
    return { snapshot, stale: false };
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
  let snapshot = state.snapshot
    ?? await readPersistentSnapshot<TokenIndexSnapshot>(PERSISTENT_CACHE_KEY);
  const upgraded = await upgradeLegacyCanonicalCheckpoint(snapshot, readCanonicalBlock);
  if (upgraded) {
    snapshot = upgraded;
    state.snapshot = upgraded;
    state.cachedAt = Date.parse(upgraded.generatedAt) || 0;
    state.canonicalCheckedAt = Date.now();
    void writePersistentSnapshot(PERSISTENT_CACHE_KEY, upgraded);
  }
  if (!snapshot) {
    return {
      available: false,
      indexedBlock: null,
      ageSeconds: null,
      checkpoint: "missing" as const,
      tokenCount: 0,
    };
  }
  const checkpoint = await getCanonicalCheckpointStatus(snapshot, readCanonicalBlock);
  const generatedAt = Date.parse(snapshot.generatedAt);
  return {
    available: true,
    indexedBlock: snapshot.indexedBlock,
    ageSeconds: Number.isFinite(generatedAt)
      ? Math.max(0, Math.floor((Date.now() - generatedAt) / 1_000))
      : null,
    checkpoint,
    tokenCount: snapshot.tokens.length,
  };
}
