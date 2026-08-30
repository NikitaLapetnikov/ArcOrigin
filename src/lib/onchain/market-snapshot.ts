import "server-only";

import { formatUnits, parseAbiItem, type Address, type Hash } from "viem";
import {
  ARCORIGIN_CROSS_MARKET_CAP_USDC,
  ARCORIGIN_NETWORK,
  ARCORIGIN_START_MARKET_CAP_USDC,
  ARC_ACTIVE_FACTORY,
} from "@/lib/chains";
import { erc20Abi, uniswapV3PoolAbi } from "@/lib/contracts";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import {
  createCanonicalCheckpoint,
  getCanonicalCheckpointStatus,
  upgradeLegacyCanonicalCheckpoint,
} from "@/lib/onchain/canonical-checkpoint";
import { FactoryTokenNotFoundError } from "@/lib/onchain/holder-snapshot";
import { getTokenIndexSnapshotForToken } from "@/lib/onchain/token-index-snapshot";
import { readPersistentSnapshot, writePersistentSnapshot } from "@/lib/server/persistent-cache";
import type { ChartPoint, TokenData, Trade } from "@/lib/types";

const swapEvent = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");
const LOG_BLOCK_RANGE = 9_999n;
const CHART_TRADE_LIMIT = 240;
const TRADE_FEED_LIMIT = 500;
const BLOCK_TIMESTAMP_CONCURRENCY = 6;
const CACHE_TTL_MS = 30_000;
const MIN_REFRESH_INTERVAL_MS = 10_000;
const FORCE_REFRESH_INTERVAL_MS = 1_500;
const MAX_TOKEN_CACHES = 50;
const MAX_BLOCK_TIMESTAMPS = 1_000;

export type MarketSnapshot = {
  price: number;
  priceChange: number;
  marketCap: number;
  volume: number;
  buyers: number;
  sellers: number;
  raisedUsdc: number;
  targetUsdc: number;
  progress: number;
  crossed: boolean;
  tokensSold: number;
  tokenReserve: number;
  chart: ChartPoint[];
  trades: Trade[];
  indexedBlock: string;
  indexedBlockHash?: Hash;
  generatedAt: string;
};

type MarketCacheEntry = {
  snapshot: MarketSnapshot | null;
  cachedAt: number;
  lastAttemptAt: number;
  canonicalCheckedAt: number;
  pending: Promise<MarketSnapshot> | null;
};

type IndexedTrade = {
  blockNumber: bigint;
  logIndex: number;
  hash: Hash;
  wallet: Address;
  type: "Buy" | "Sell";
  usdc: number;
  tokens: number;
  executionPrice: number;
  timestamp?: number;
};

type MarketState = {
  tokenCaches: Map<string, MarketCacheEntry>;
  blockTimestamps: Map<string, number>;
};

const publicClient = createArcPublicClient(
  ARCORIGIN_NETWORK === "mainnet" ? process.env.ARC_MAINNET_RPC_URL : process.env.ARC_TESTNET_RPC_URL,
);

declare global {
  var __arcOriginMarketState: MarketState | undefined;
}

const state = globalThis.__arcOriginMarketState ?? { tokenCaches: new Map(), blockTimestamps: new Map() };
globalThis.__arcOriginMarketState = state;

function readCanonicalBlock(blockNumber: bigint) {
  return publicClient.getBlock({ blockNumber });
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function uniswapPriceFromSqrt(sqrtPriceX96: bigint, tokenIsToken0: boolean) {
  const normalized = Number(sqrtPriceX96) / 2 ** 96;
  const rawToken1PerToken0 = normalized * normalized;
  const price = tokenIsToken0 ? rawToken1PerToken0 * 1e12 : 1e12 / rawToken1PerToken0;
  if (!Number.isFinite(price) || price <= 0) throw new Error("Uniswap pool price is invalid.");
  return price;
}

async function loadBlockTimestamps(blockNumbers: bigint[]) {
  const timestamps = new Map<string, number>();
  const missing: string[] = [];
  for (const blockKey of [...new Set(blockNumbers.map(String))]) {
    const cached = state.blockTimestamps.get(blockKey);
    if (cached === undefined) missing.push(blockKey);
    else timestamps.set(blockKey, cached);
  }
  for (let offset = 0; offset < missing.length; offset += BLOCK_TIMESTAMP_CONCURRENCY) {
    const blocks = await Promise.all(missing.slice(offset, offset + BLOCK_TIMESTAMP_CONCURRENCY).map(async (blockKey) => ({
      blockKey,
      block: await withRpcRetry(() => publicClient.getBlock({ blockNumber: BigInt(blockKey) }), 2),
    })));
    for (const { blockKey, block } of blocks) {
      const timestamp = Number(block.timestamp);
      state.blockTimestamps.set(blockKey, timestamp);
      timestamps.set(blockKey, timestamp);
      if (state.blockTimestamps.size > MAX_BLOCK_TIMESTAMPS) {
        const oldestKey = state.blockTimestamps.keys().next().value as string | undefined;
        if (oldestKey) state.blockTimestamps.delete(oldestKey);
      }
    }
  }
  return timestamps;
}

async function loadUniswapMarketSnapshot(baseToken: TokenData, indexedBlock: bigint): Promise<MarketSnapshot> {
  if (!baseToken.poolAddress || baseToken.launchBlock === undefined || baseToken.launchedAt === undefined || baseToken.totalSupply === undefined) {
    throw new Error("Factory token configuration is incomplete.");
  }
  const tokenAddress = baseToken.address as Address;
  const pool = baseToken.poolAddress as Address;
  const launchBlock = BigInt(baseToken.launchBlock);
  const [poolToken0, slot0, tokenReserveRaw] = await Promise.all([
    withRpcRetry(() => publicClient.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "token0", blockNumber: indexedBlock }), 2),
    withRpcRetry(() => publicClient.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "slot0", blockNumber: indexedBlock }), 2),
    withRpcRetry(() => publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [pool], blockNumber: indexedBlock }), 2),
  ]);
  const tokenIsToken0 = poolToken0.toLowerCase() === tokenAddress.toLowerCase();
  const currentPrice = uniswapPriceFromSqrt(slot0[0], tokenIsToken0);
  const events: IndexedTrade[] = [];
  for (let fromBlock = launchBlock; fromBlock <= indexedBlock; fromBlock += LOG_BLOCK_RANGE + 1n) {
    const toBlock = fromBlock + LOG_BLOCK_RANGE < indexedBlock ? fromBlock + LOG_BLOCK_RANGE : indexedBlock;
    const logs = await withRpcRetry(() => publicClient.getLogs({ address: pool, event: swapEvent, fromBlock, toBlock }));
    for (const log of logs) {
      const amount0 = log.args.amount0 ?? 0n;
      const amount1 = log.args.amount1 ?? 0n;
      const tokenDelta = tokenIsToken0 ? amount0 : amount1;
      const usdcDelta = tokenIsToken0 ? amount1 : amount0;
      if (tokenDelta === 0n || usdcDelta === 0n || (tokenDelta < 0n) === (usdcDelta < 0n)) continue;
      events.push({
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
        hash: log.transactionHash as Hash,
        wallet: (log.args.recipient ?? log.args.sender) as Address,
        type: tokenDelta < 0n ? "Buy" : "Sell",
        usdc: Number(formatUnits(usdcDelta < 0n ? -usdcDelta : usdcDelta, 6)),
        tokens: Number(formatUnits(tokenDelta < 0n ? -tokenDelta : tokenDelta, 18)),
        executionPrice: uniswapPriceFromSqrt(log.args.sqrtPriceX96 ?? slot0[0], tokenIsToken0),
      });
    }
  }
  const unique = new Map<string, IndexedTrade>();
  for (const event of events) unique.set(`${event.hash.toLowerCase()}:${event.logIndex}`, event);
  const validEvents = [...unique.values()].filter((event) => event.tokens > 0).sort((left, right) => left.blockNumber === right.blockNumber
    ? left.logIndex - right.logIndex
    : left.blockNumber < right.blockNumber ? -1 : 1);
  const timestamps = await loadBlockTimestamps(validEvents.map((event) => event.blockNumber));
  for (const event of validEvents) event.timestamp = timestamps.get(event.blockNumber.toString());

  const totalSupply = baseToken.totalSupply;
  const launchPrice = ARCORIGIN_START_MARKET_CAP_USDC / totalSupply;
  const marketCap = currentPrice * totalSupply;
  const cutoff24h = Math.floor(Date.now() / 1_000) - 86_400;
  const recentEvents = validEvents.filter((event) => (event.timestamp ?? 0) >= cutoff24h);
  const firstInWindow = validEvents.findIndex((event) => (event.timestamp ?? 0) >= cutoff24h);
  const comparisonPrice = firstInWindow < 0 ? currentPrice : firstInWindow > 0 ? validEvents[firstInWindow - 1].executionPrice : launchPrice;
  const tokenReserve = Number(formatUnits(tokenReserveRaw, 18));
  const trades: Trade[] = validEvents.slice(-TRADE_FEED_LIMIT).reverse().map((event) => ({
    time: `Block ${event.blockNumber}`,
    timestamp: event.timestamp,
    type: event.type,
    wallet: event.wallet,
    usdc: event.usdc,
    tokens: event.tokens,
    price: event.usdc / event.tokens,
    txHash: event.hash,
  }));
  const chart: ChartPoint[] = [
    { time: "Launch", timestamp: baseToken.launchedAt, price: launchPrice, volume: 0 },
    ...validEvents.slice(-CHART_TRADE_LIMIT).map((event) => ({
      time: `#${event.blockNumber % 100_000n}`,
      timestamp: event.timestamp,
      price: event.executionPrice,
      volume: event.usdc,
    })),
  ];
  const checkpoint = await createCanonicalCheckpoint(indexedBlock, readCanonicalBlock);
  return {
    price: currentPrice,
    priceChange: comparisonPrice > 0 ? (currentPrice / comparisonPrice - 1) * 100 : 0,
    marketCap,
    volume: recentEvents.reduce((sum, event) => sum + event.usdc, 0),
    buyers: recentEvents.filter((event) => event.type === "Buy").length,
    sellers: recentEvents.filter((event) => event.type === "Sell").length,
    raisedUsdc: marketCap,
    targetUsdc: ARCORIGIN_CROSS_MARKET_CAP_USDC,
    progress: Math.min(100, marketCap / ARCORIGIN_CROSS_MARKET_CAP_USDC * 100),
    crossed: marketCap >= ARCORIGIN_CROSS_MARKET_CAP_USDC,
    tokensSold: Math.max(0, totalSupply - tokenReserve),
    tokenReserve,
    chart,
    trades,
    ...checkpoint,
    generatedAt: new Date().toISOString(),
  };
}

async function loadMarketSnapshot(tokenAddress: Address, forceRefresh: boolean) {
  const indexResult = await getTokenIndexSnapshotForToken(tokenAddress, forceRefresh);
  const indexSnapshot = indexResult.snapshot;
  if (!indexSnapshot) throw new Error("Factory token index is unavailable.");
  const baseToken = indexSnapshot.tokens.find((token) => token.address.toLowerCase() === tokenAddress.toLowerCase());
  if (!baseToken) throw new FactoryTokenNotFoundError("Token was not launched by the configured ArcOrigin factory.");
  const indexedBlock = forceRefresh ? await withRpcRetry(() => publicClient.getBlockNumber(), 2) : BigInt(indexSnapshot.indexedBlock);
  return loadUniswapMarketSnapshot(baseToken, indexedBlock);
}

function getTokenCache(tokenAddress: Address) {
  const key = tokenAddress.toLowerCase();
  const existing = state.tokenCaches.get(key);
  if (existing) return existing;
  if (state.tokenCaches.size >= MAX_TOKEN_CACHES) {
    const oldestKey = state.tokenCaches.keys().next().value as string | undefined;
    if (oldestKey) state.tokenCaches.delete(oldestKey);
  }
  const entry: MarketCacheEntry = { snapshot: null, cachedAt: 0, lastAttemptAt: 0, canonicalCheckedAt: 0, pending: null };
  state.tokenCaches.set(key, entry);
  return entry;
}

export async function getMarketSnapshot(tokenAddress: Address, forceRefresh = false) {
  const cache = getTokenCache(tokenAddress);
  const persistentKey = `arcorigin:${ARCORIGIN_NETWORK}:market:${ARC_ACTIVE_FACTORY.toLowerCase()}:${tokenAddress.toLowerCase()}`;
  if (!cache.snapshot) {
    let persisted = await readPersistentSnapshot<MarketSnapshot>(persistentKey);
    const upgraded = await upgradeLegacyCanonicalCheckpoint(persisted, readCanonicalBlock);
    if (upgraded) {
      persisted = upgraded;
      void writePersistentSnapshot(persistentKey, upgraded);
    }
    const checkpointStatus = persisted ? await getCanonicalCheckpointStatus(persisted, readCanonicalBlock) : "invalid";
    if (persisted?.indexedBlock && Array.isArray(persisted.trades) && (checkpointStatus === "canonical" || checkpointStatus === "unavailable")) {
      cache.snapshot = persisted;
      cache.cachedAt = Date.parse(persisted.generatedAt) || 0;
      cache.canonicalCheckedAt = Date.now();
    }
  }
  const now = Date.now();
  if (cache.snapshot && now - cache.canonicalCheckedAt >= MIN_REFRESH_INTERVAL_MS) {
    const checkpointStatus = await getCanonicalCheckpointStatus(cache.snapshot, readCanonicalBlock);
    cache.canonicalCheckedAt = now;
    if (checkpointStatus === "orphaned" || checkpointStatus === "invalid") {
      cache.snapshot = null;
      cache.cachedAt = 0;
    }
  }
  const isFresh = cache.snapshot && now - cache.cachedAt < CACHE_TTL_MS;
  const refreshThrottled = cache.snapshot && now - cache.lastAttemptAt < (forceRefresh ? FORCE_REFRESH_INTERVAL_MS : MIN_REFRESH_INTERVAL_MS);
  if (isFresh && !forceRefresh) return { snapshot: cache.snapshot, stale: false };
  if (refreshThrottled) return { snapshot: cache.snapshot, stale: now - cache.cachedAt >= CACHE_TTL_MS };
  if (!cache.snapshot && !cache.pending && cache.lastAttemptAt > 0 && now - cache.lastAttemptAt < MIN_REFRESH_INTERVAL_MS) throw new Error("Arc RPC rate limit cooldown is active.");
  if (!cache.pending) {
    cache.lastAttemptAt = now;
    cache.pending = loadMarketSnapshot(tokenAddress, forceRefresh).then((snapshot) => {
      cache.snapshot = snapshot;
      cache.cachedAt = Date.now();
      cache.canonicalCheckedAt = Date.now();
      void writePersistentSnapshot(persistentKey, snapshot);
      return snapshot;
    }).finally(() => { cache.pending = null; });
  }
  if (cache.snapshot && !forceRefresh) {
    void cache.pending?.catch(() => undefined);
    return { snapshot: cache.snapshot, stale: true };
  }
  try {
    return { snapshot: await cache.pending, stale: false };
  } catch (error) {
    if (cache.snapshot) return { snapshot: cache.snapshot, stale: true };
    throw error;
  }
}

export function isMarketRpcError(error: unknown) {
  return isRetryableRpcError(error);
}
