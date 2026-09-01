import "server-only";

import { formatUnits, getAddress, isAddress, parseAbiItem, type Address, type Hash } from "viem";
import { ARCORIGIN_NETWORK, ARC_ACTIVE_FACTORY, ARC_ACTIVE_FACTORY_BLOCK } from "@/lib/chains";
import { factoryAbi, liquidityLockerAbi } from "@/lib/contracts";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import { FactoryTokenNotFoundError } from "@/lib/onchain/holder-snapshot";
import { getTokenIndexSnapshotForToken } from "@/lib/onchain/token-index-snapshot";
import { readPersistentSnapshot, writePersistentSnapshot } from "@/lib/server/persistent-cache";
import { getStoredBuybacks } from "@/lib/server/event-store";

const buybackExecutedEvent = parseAbiItem("event BuybackExecuted(uint256 indexed positionId, address indexed keeper, uint256 quoteSpent, uint256 keeperReward, uint256 launchTokensBurned, uint256 remainingQuoteReserve)");
const LOG_BLOCK_RANGE = 9_999n;
const CACHE_TTL_MS = 20_000;
const PERSISTENT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

export type BuybackExecution = {
  txHash: Hash;
  blockNumber: string;
  timestamp: number;
  keeper: Address;
  usdcSpent: number;
  keeperRewardUsdc: number;
  tokensBurned: number;
};

export type BuybackSnapshot = {
  enabled: boolean;
  ready: boolean;
  reserveUsdc: number;
  nextExecutionAt: number;
  totalUsdcSpent: number;
  totalTokensBurned: number;
  executionCount: number;
  latestExecution: BuybackExecution | null;
  keeper: {
    address: Address;
    balanceUsdc: number;
    platform: boolean;
  } | null;
  indexedBlock: string;
  generatedAt: string;
};

type CacheEntry = { snapshot: BuybackSnapshot; cachedAt: number };
type BuybackState = {
  cache: Map<string, CacheEntry>;
  pending: Map<string, Promise<BuybackSnapshot>>;
};

export type BuybackSnapshotResult = {
  snapshot: BuybackSnapshot;
  stale: boolean;
};

const publicClient = createArcPublicClient(
  process.env.ARC_MAINNET_RPC_URL,
);

declare global {
  var __arcOriginBuybackState: BuybackState | undefined;
}

const state = globalThis.__arcOriginBuybackState ?? {
  cache: new Map<string, CacheEntry>(),
  pending: new Map<string, Promise<BuybackSnapshot>>(),
};
globalThis.__arcOriginBuybackState = state;

function persistentCacheKey(tokenAddress: string) {
  return `arcorigin:${ARCORIGIN_NETWORK}:buybacks:${ARC_ACTIVE_FACTORY.toLowerCase()}:${tokenAddress.toLowerCase()}`;
}

function finiteNonNegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBuybackSnapshot(value: unknown): value is BuybackSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<BuybackSnapshot>;
  const latest = snapshot.latestExecution;
  const keeper = snapshot.keeper;
  return typeof snapshot.enabled === "boolean"
    && typeof snapshot.ready === "boolean"
    && finiteNonNegative(snapshot.reserveUsdc)
    && finiteNonNegative(snapshot.nextExecutionAt)
    && finiteNonNegative(snapshot.totalUsdcSpent)
    && finiteNonNegative(snapshot.totalTokensBurned)
    && Number.isInteger(snapshot.executionCount)
    && finiteNonNegative(snapshot.executionCount)
    && (latest === null || Boolean(
      latest
      && typeof latest === "object"
      && typeof latest.txHash === "string"
      && /^0x[0-9a-fA-F]{64}$/.test(latest.txHash)
      && typeof latest.blockNumber === "string"
      && /^\d+$/.test(latest.blockNumber)
      && finiteNonNegative(latest.timestamp)
      && typeof latest.keeper === "string"
      && isAddress(latest.keeper)
      && finiteNonNegative(latest.usdcSpent)
      && finiteNonNegative(latest.keeperRewardUsdc)
      && finiteNonNegative(latest.tokensBurned)
    ))
    && (keeper === null || Boolean(
      keeper
      && typeof keeper === "object"
      && typeof keeper.address === "string"
      && isAddress(keeper.address)
      && finiteNonNegative(keeper.balanceUsdc)
      && typeof keeper.platform === "boolean"
    ))
    && typeof snapshot.indexedBlock === "string"
    && /^\d+$/.test(snapshot.indexedBlock)
    && typeof snapshot.generatedAt === "string"
    && Number.isFinite(Date.parse(snapshot.generatedAt));
}

function storeSnapshot(tokenAddress: string, snapshot: BuybackSnapshot) {
  const cacheKey = tokenAddress.toLowerCase();
  state.cache.set(cacheKey, { snapshot, cachedAt: Date.now() });
  void writePersistentSnapshot(
    persistentCacheKey(cacheKey),
    snapshot,
    PERSISTENT_CACHE_TTL_SECONDS,
  );
  return snapshot;
}

export async function getCachedBuybackSnapshot(tokenAddress: Address) {
  const cacheKey = tokenAddress.toLowerCase();
  const cached = state.cache.get(cacheKey);
  if (cached && isBuybackSnapshot(cached.snapshot)) return cached.snapshot;
  const persisted = await readPersistentSnapshot<unknown>(persistentCacheKey(cacheKey));
  if (!isBuybackSnapshot(persisted)) return null;
  state.cache.set(cacheKey, {
    snapshot: persisted,
    cachedAt: Date.parse(persisted.generatedAt) || 0,
  });
  return persisted;
}

export function invalidateBuybackSnapshot(tokenAddress: string) {
  const cached = state.cache.get(tokenAddress.toLowerCase());
  if (cached) cached.cachedAt = 0;
}

type IndexedBuybackEvent = {
  txHash: Hash;
  blockNumber: bigint;
  timestamp?: number;
  keeper: Address;
  quoteSpent: bigint;
  keeperReward: bigint;
  launchTokensBurned: bigint;
};

async function readBuybackEvents(
  locker: Address,
  positionId: bigint,
  indexedBlock: bigint,
  tokenAddress: Address,
) {
  const stored = await getStoredBuybacks(tokenAddress);
  const minimumStoredBlock = indexedBlock > 20n ? indexedBlock - 20n : 0n;
  if (stored
    && BigInt(stored.checkpoint.indexedBlock) >= ARC_ACTIVE_FACTORY_BLOCK
    && BigInt(stored.checkpoint.indexedBlock) >= minimumStoredBlock) {
    return stored.events.map((event): IndexedBuybackEvent => ({
      txHash: event.transactionHash,
      blockNumber: event.blockNumber,
      timestamp: event.timestamp,
      keeper: event.keeper,
      quoteSpent: event.quoteSpent,
      keeperReward: event.keeperReward,
      launchTokensBurned: event.launchTokensBurned,
    }));
  }
  const events: IndexedBuybackEvent[] = [];
  for (let fromBlock = ARC_ACTIVE_FACTORY_BLOCK; fromBlock <= indexedBlock; fromBlock += LOG_BLOCK_RANGE + 1n) {
    const toBlock = fromBlock + LOG_BLOCK_RANGE < indexedBlock ? fromBlock + LOG_BLOCK_RANGE : indexedBlock;
    const logs = await publicClient.getLogs({
      address: locker,
      event: buybackExecutedEvent,
      args: { positionId },
      fromBlock,
      toBlock,
    });
    for (const log of logs) {
      if (!log.transactionHash || log.blockNumber === null) continue;
      events.push({
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        keeper: getAddress(log.args.keeper as Address),
        quoteSpent: log.args.quoteSpent ?? 0n,
        keeperReward: log.args.keeperReward ?? 0n,
        launchTokensBurned: log.args.launchTokensBurned ?? 0n,
      });
    }
  }
  return events.sort((left, right) => left.blockNumber < right.blockNumber ? -1 : left.blockNumber > right.blockNumber ? 1 : 0);
}

function configuredKeeperAddress() {
  const value = process.env.BUYBACK_KEEPER_ADDRESS?.trim();
  return value && isAddress(value) ? getAddress(value) : null;
}

async function loadBuybackSnapshot(tokenAddress: Address, forceRefresh: boolean) {
  const cacheKey = tokenAddress.toLowerCase();
  const indexResult = await getTokenIndexSnapshotForToken(tokenAddress, forceRefresh);
  const token = indexResult.snapshot?.tokens.find((item) => item.address.toLowerCase() === cacheKey);
  if (!token) throw new FactoryTokenNotFoundError("Token was not launched by the configured ArcOrigin factory.");
  const indexedBlock = forceRefresh ? await publicClient.getBlockNumber() : BigInt(indexResult.snapshot?.indexedBlock ?? 0);

  if (!token.automaticBuyback || !token.positionId) {
    const snapshot: BuybackSnapshot = {
      enabled: false,
      ready: false,
      reserveUsdc: 0,
      nextExecutionAt: 0,
      totalUsdcSpent: 0,
      totalTokensBurned: 0,
      executionCount: 0,
      latestExecution: null,
      keeper: null,
      indexedBlock: indexedBlock.toString(),
      generatedAt: new Date().toISOString(),
    };
    return storeSnapshot(cacheKey, snapshot);
  }

  const locker = getAddress(await publicClient.readContract({
    address: ARC_ACTIVE_FACTORY,
    abi: factoryAbi,
    functionName: "liquidityLocker",
  }));
  const positionId = BigInt(token.positionId);
  const [readyState, events] = await Promise.all([
    publicClient.readContract({
      address: locker,
      abi: liquidityLockerAbi,
      functionName: "buybackReady",
      args: [positionId],
      blockNumber: indexedBlock,
    }),
    readBuybackEvents(locker, positionId, indexedBlock, tokenAddress),
  ]);
  const latestEvent = events.at(-1);
  const configuredKeeper = configuredKeeperAddress();
  const keeperAddress = configuredKeeper ?? latestEvent?.keeper ?? null;
  const [latestBlock, keeperBalance] = await Promise.all([
    latestEvent && latestEvent.timestamp === undefined
      ? publicClient.getBlock({ blockNumber: latestEvent.blockNumber })
      : null,
    keeperAddress ? publicClient.getBalance({ address: keeperAddress, blockNumber: indexedBlock }) : null,
  ]);
  const latestExecution: BuybackExecution | null = latestEvent ? {
    txHash: latestEvent.txHash,
    blockNumber: latestEvent.blockNumber.toString(),
    timestamp: latestEvent.timestamp ?? Number(latestBlock?.timestamp ?? 0n),
    keeper: latestEvent.keeper,
    usdcSpent: Number(formatUnits(latestEvent.quoteSpent, 6)),
    keeperRewardUsdc: Number(formatUnits(latestEvent.keeperReward, 6)),
    tokensBurned: Number(formatUnits(latestEvent.launchTokensBurned, 18)),
  } : null;
  const snapshot: BuybackSnapshot = {
    enabled: true,
    ready: readyState[0],
    reserveUsdc: Number(formatUnits(readyState[1], 6)),
    nextExecutionAt: Number(readyState[2]),
    totalUsdcSpent: events.reduce((total, event) => total + Number(formatUnits(event.quoteSpent, 6)), 0),
    totalTokensBurned: events.reduce((total, event) => total + Number(formatUnits(event.launchTokensBurned, 18)), 0),
    executionCount: events.length,
    latestExecution,
    keeper: keeperAddress && keeperBalance !== null ? {
      address: keeperAddress,
      balanceUsdc: Number(formatUnits(keeperBalance, 18)),
      platform: configuredKeeper !== null,
    } : null,
    indexedBlock: indexedBlock.toString(),
    generatedAt: new Date().toISOString(),
  };
  return storeSnapshot(cacheKey, snapshot);
}

function refreshSnapshot(tokenAddress: Address, forceRefresh: boolean) {
  const cacheKey = tokenAddress.toLowerCase();
  const existing = state.pending.get(cacheKey);
  if (existing) return existing;
  const pending = loadBuybackSnapshot(tokenAddress, forceRefresh)
    .finally(() => state.pending.delete(cacheKey));
  state.pending.set(cacheKey, pending);
  return pending;
}

export async function getBuybackSnapshotResult(
  tokenAddress: Address,
  forceRefresh = false,
): Promise<BuybackSnapshotResult> {
  const cacheKey = tokenAddress.toLowerCase();
  const cachedSnapshot = await getCachedBuybackSnapshot(tokenAddress);
  const cachedEntry = state.cache.get(cacheKey);
  const isFresh = cachedSnapshot
    && cachedEntry
    && Date.now() - cachedEntry.cachedAt < CACHE_TTL_MS;
  if (isFresh && !forceRefresh) return { snapshot: cachedSnapshot, stale: false };

  const pending = refreshSnapshot(tokenAddress, true);
  if (cachedSnapshot && !forceRefresh) {
    void pending.catch(() => undefined);
    return { snapshot: cachedSnapshot, stale: true };
  }
  try {
    return { snapshot: await pending, stale: false };
  } catch (error) {
    if (cachedSnapshot) return { snapshot: cachedSnapshot, stale: true };
    throw error;
  }
}

export async function getBuybackSnapshot(tokenAddress: Address, forceRefresh = false) {
  return (await getBuybackSnapshotResult(tokenAddress, forceRefresh)).snapshot;
}
