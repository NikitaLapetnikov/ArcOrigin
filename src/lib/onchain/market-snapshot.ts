import "server-only";

import { decodeEventLog, formatUnits, parseAbiItem, type Address, type Hash } from "viem";
import { usesPermanentLiquidityMode } from "@/lib/bonding-curve";
import { bondingCurveAbi } from "@/lib/contracts";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import { getArcscanLogs } from "@/lib/onchain/arcscan-logs";
import { FactoryTokenNotFoundError } from "@/lib/onchain/holder-snapshot";
import { getTokenIndexSnapshotForToken } from "@/lib/onchain/token-index-snapshot";
import { readPersistentSnapshot, writePersistentSnapshot } from "@/lib/server/persistent-cache";
import type { ChartPoint, Trade } from "@/lib/types";

const tokenBoughtEvent = parseAbiItem("event TokenBought(address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 fee)");
const tokenSoldEvent = parseAbiItem("event TokenSold(address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 fee)");
const tradeEvents = [tokenBoughtEvent, tokenSoldEvent] as const;
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
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
  graduated: boolean;
  tokensSold: number;
  tokenReserve: number;
  chart: ChartPoint[];
  trades: Trade[];
  indexedBlock: string;
  generatedAt: string;
};

type MarketCacheEntry = {
  snapshot: MarketSnapshot | null;
  cachedAt: number;
  lastAttemptAt: number;
  pending: Promise<MarketSnapshot> | null;
};

type IndexedTrade = {
  blockNumber: bigint;
  logIndex: number;
  hash: Hash;
  wallet: Address;
  type: "Buy" | "Sell";
  usdc: number;
  notional: number;
  reserveUsdcDelta: number;
  tokens: number;
  timestamp?: number;
};

type IndexedPriceTick = {
  event: IndexedTrade;
  price: number;
};

type MarketState = {
  tokenCaches: Map<string, MarketCacheEntry>;
  blockTimestamps: Map<string, number>;
};

const publicClient = createArcPublicClient(process.env.ARC_TESTNET_RPC_URL);

declare global {
  var __arcOriginMarketState: MarketState | undefined;
}

const state = globalThis.__arcOriginMarketState ?? { tokenCaches: new Map(), blockTimestamps: new Map() };
globalThis.__arcOriginMarketState = state;

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

function roundUsdc(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function loadBlockTimestamps(blockNumbers: bigint[]) {
  const timestamps = new Map<string, number>();
  const uniqueBlocks = [...new Set(blockNumbers.map((blockNumber) => blockNumber.toString()))];
  const missingBlocks: string[] = [];
  for (const blockKey of uniqueBlocks) {
    const cached = state.blockTimestamps.get(blockKey);
    if (cached !== undefined) {
      timestamps.set(blockKey, cached);
      continue;
    }
    missingBlocks.push(blockKey);
  }
  const blocks: Array<{ blockKey: string; block: { timestamp: bigint } }> = [];
  for (let offset = 0; offset < missingBlocks.length; offset += BLOCK_TIMESTAMP_CONCURRENCY) {
    blocks.push(...await Promise.all(
      missingBlocks.slice(offset, offset + BLOCK_TIMESTAMP_CONCURRENCY).map(async (blockKey) => ({
        blockKey,
        block: await withRpcRetry(
          () => publicClient.getBlock({ blockNumber: BigInt(blockKey) }),
          2,
        ),
      })),
    ));
    if (offset + BLOCK_TIMESTAMP_CONCURRENCY < missingBlocks.length) await wait(120);
  }
  for (const { blockKey, block } of blocks) {
    const timestamp = Number(block.timestamp);
    state.blockTimestamps.set(blockKey, timestamp);
    timestamps.set(blockKey, timestamp);
    if (state.blockTimestamps.size > MAX_BLOCK_TIMESTAMPS) {
      const oldestKey = state.blockTimestamps.keys().next().value as string | undefined;
      if (oldestKey) state.blockTimestamps.delete(oldestKey);
    }
  }
  return timestamps;
}

async function loadMarketSnapshot(tokenAddress: Address, forceRefresh: boolean): Promise<MarketSnapshot> {
  const indexResult = await getTokenIndexSnapshotForToken(tokenAddress, forceRefresh);
  const indexSnapshot = indexResult.snapshot;
  if (!indexSnapshot) throw new Error("Factory token index is unavailable.");
  const baseToken = indexSnapshot.tokens.find((token) => token.address.toLowerCase() === tokenAddress.toLowerCase());
  if (!baseToken) throw new FactoryTokenNotFoundError("Token was not launched by the configured ArcOrigin factory.");
  if (!baseToken.curveAddress
    || baseToken.launchBlock === undefined
    || baseToken.launchedAt === undefined
    || baseToken.totalSupply === undefined
    || baseToken.creatorAllocationPercent === undefined
    || baseToken.virtualUsdcReserve === undefined) {
    throw new Error("Factory token configuration is incomplete.");
  }
  const indexedBlock = forceRefresh
    ? await withRpcRetry(() => publicClient.getBlockNumber(), 2)
    : BigInt(indexSnapshot.indexedBlock);
  const launch = {
    curve: baseToken.curveAddress as Address,
    launchBlock: BigInt(baseToken.launchBlock),
    launchedAt: baseToken.launchedAt,
  };

  const events: IndexedTrade[] = [];
  let explorerLogs;
  if (!forceRefresh) {
    try {
      explorerLogs = await getArcscanLogs({
        address: launch.curve,
        fromBlock: launch.launchBlock,
        toBlock: indexedBlock,
      });
    } catch {
      explorerLogs = null;
    }
  }
  if (explorerLogs) {
    for (const log of explorerLogs) {
      let decoded;
      try {
        decoded = decodeEventLog({ abi: tradeEvents, data: log.data, topics: log.topics });
      } catch {
        continue;
      }
      events.push(decoded.eventName === "TokenBought" ? {
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        hash: log.transactionHash,
        wallet: decoded.args.buyer,
        type: "Buy",
        usdc: Number(formatUnits(decoded.args.usdcIn, 6)),
        notional: Number(formatUnits(decoded.args.usdcIn, 6)),
        reserveUsdcDelta: Number(formatUnits(decoded.args.usdcIn - decoded.args.fee, 6)),
        tokens: Number(formatUnits(decoded.args.tokensOut, 18)),
        timestamp: log.timestamp,
      } : {
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
        hash: log.transactionHash,
        wallet: decoded.args.seller,
        type: "Sell",
        usdc: Number(formatUnits(decoded.args.usdcOut, 6)),
        notional: Number(formatUnits(decoded.args.usdcOut + decoded.args.fee, 6)),
        reserveUsdcDelta: -Number(formatUnits(decoded.args.usdcOut + decoded.args.fee, 6)),
        tokens: Number(formatUnits(decoded.args.tokensIn, 18)),
        timestamp: log.timestamp,
      });
    }
  } else {
    for (let fromBlock = launch.launchBlock; fromBlock <= indexedBlock; fromBlock += LOG_BLOCK_RANGE + 1n) {
      const toBlock = fromBlock + LOG_BLOCK_RANGE < indexedBlock ? fromBlock + LOG_BLOCK_RANGE : indexedBlock;
      const logs = await withRpcRetry(() => publicClient.getLogs({
        address: launch.curve,
        events: tradeEvents,
        fromBlock,
        toBlock,
      }));
      for (const log of logs) {
        events.push(log.eventName === "TokenBought" ? {
          blockNumber: log.blockNumber ?? 0n,
          logIndex: log.logIndex ?? 0,
          hash: log.transactionHash as Hash,
          wallet: log.args.buyer as Address,
          type: "Buy",
          usdc: Number(formatUnits(log.args.usdcIn ?? 0n, 6)),
          notional: Number(formatUnits(log.args.usdcIn ?? 0n, 6)),
          reserveUsdcDelta: Number(formatUnits((log.args.usdcIn ?? 0n) - (log.args.fee ?? 0n), 6)),
          tokens: Number(formatUnits(log.args.tokensOut ?? 0n, 18)),
        } : {
          blockNumber: log.blockNumber ?? 0n,
          logIndex: log.logIndex ?? 0,
          hash: log.transactionHash as Hash,
          wallet: log.args.seller as Address,
          type: "Sell",
          usdc: Number(formatUnits(log.args.usdcOut ?? 0n, 6)),
          notional: Number(formatUnits((log.args.usdcOut ?? 0n) + (log.args.fee ?? 0n), 6)),
          reserveUsdcDelta: -Number(formatUnits((log.args.usdcOut ?? 0n) + (log.args.fee ?? 0n), 6)),
          tokens: Number(formatUnits(log.args.tokensIn ?? 0n, 18)),
        });
      }
      await wait(180);
    }
  }

  const totalSupply = baseToken.totalSupply;
  const initialReserve = totalSupply * (1 - baseToken.creatorAllocationPercent / 100);
  const virtualUsdc = baseToken.virtualUsdcReserve;
  const targetUsdc = baseToken.targetUSDC;
  const launchPrice = virtualUsdc / initialReserve;

  const validEvents = events.filter((event) => event.tokens > 0).sort((left, right) => left.blockNumber === right.blockNumber
    ? left.logIndex - right.logIndex
    : left.blockNumber < right.blockNumber ? -1 : 1);
  let reconstructedTokenReserve = initialReserve;
  let reconstructedRaisedUsdc = 0;
  let reconstructedGraduated = false;
  const permanentLiquidityMode = usesPermanentLiquidityMode(virtualUsdc, targetUsdc);
  const priceTicks: IndexedPriceTick[] = [];
  for (const event of validEvents) {
    reconstructedTokenReserve += event.type === "Buy" ? -event.tokens : event.tokens;
    reconstructedRaisedUsdc = roundUsdc(Math.max(0, reconstructedRaisedUsdc + event.reserveUsdcDelta));
    if (reconstructedTokenReserve <= 0) throw new Error("Curve reserves are invalid at the indexed block.");
    if (!reconstructedGraduated && reconstructedRaisedUsdc >= targetUsdc) {
      reconstructedGraduated = true;
      if (permanentLiquidityMode) {
        reconstructedTokenReserve = Math.ceil(
          reconstructedRaisedUsdc * reconstructedTokenReserve / (virtualUsdc + reconstructedRaisedUsdc),
        );
      }
    }
    priceTicks.push({
      event,
      price: (reconstructedGraduated && permanentLiquidityMode
        ? reconstructedRaisedUsdc
        : virtualUsdc + reconstructedRaisedUsdc) / reconstructedTokenReserve,
    });
  }
  if (reconstructedTokenReserve <= 0 || initialReserve <= 0 || totalSupply <= 0) {
    throw new Error("Curve reserves are invalid at the indexed block.");
  }

  const [tokenReserveRaw, usdcReserveRaw, graduated, tokensSoldRaw] = await withRpcRetry(
    () => publicClient.multicall({
      allowFailure: false,
      blockNumber: indexedBlock,
      multicallAddress: MULTICALL3_ADDRESS,
      contracts: [
        { address: launch.curve, abi: bondingCurveAbi, functionName: "tokenReserve" },
        { address: launch.curve, abi: bondingCurveAbi, functionName: "usdcReserve" },
        { address: launch.curve, abi: bondingCurveAbi, functionName: "isGraduated" },
        { address: launch.curve, abi: bondingCurveAbi, functionName: "tokensSold" },
      ],
    }),
    2,
  );
  const tokenReserve = Number(formatUnits(tokenReserveRaw, 18));
  const raisedUsdc = Number(formatUnits(usdcReserveRaw, 6));
  const tokensSold = Number(formatUnits(tokensSoldRaw, 18));
  if (!Number.isFinite(tokenReserve) || tokenReserve <= 0 || !Number.isFinite(raisedUsdc) || raisedUsdc < 0) {
    throw new Error("Curve state is invalid at the indexed block.");
  }
  const price = (graduated && permanentLiquidityMode ? raisedUsdc : virtualUsdc + raisedUsdc) / tokenReserve;

  const chartTicks = priceTicks.slice(-CHART_TRADE_LIMIT);
  const missingTimestampBlocks = validEvents
    .filter((event) => event.timestamp === undefined)
    .map((event) => event.blockNumber);
  const blockTimestamps = missingTimestampBlocks.length > 0
    ? await loadBlockTimestamps(missingTimestampBlocks)
    : new Map<string, number>();
  for (const event of validEvents) {
    event.timestamp ??= blockTimestamps.get(event.blockNumber.toString());
  }
  const trades: Trade[] = validEvents.slice(-TRADE_FEED_LIMIT).reverse().map((event) => ({
    time: `Block ${event.blockNumber.toString()}`,
    timestamp: event.timestamp,
    type: event.type,
    wallet: event.wallet,
    usdc: event.usdc,
    tokens: event.tokens,
    price: event.notional / event.tokens,
    txHash: event.hash,
  }));
  const chart: ChartPoint[] = [
    { time: "Launch", timestamp: launch.launchedAt, price: launchPrice, volume: 0 },
    ...chartTicks.map(({ event, price: reconstructedPrice }, index) => ({
      time: `#${(event.blockNumber % 100_000n).toString()}`,
      timestamp: event.timestamp,
      price: index === chartTicks.length - 1 ? price : reconstructedPrice,
      volume: event.notional,
    })),
  ];
  const cutoff24h = Math.floor(Date.now() / 1_000) - 24 * 60 * 60;
  const recentEvents = validEvents.filter((event) => (event.timestamp ?? 0) >= cutoff24h);
  const firstTickInWindow = priceTicks.findIndex(({ event }) => (event.timestamp ?? 0) >= cutoff24h);
  const comparisonPrice = firstTickInWindow < 0
    ? price
    : firstTickInWindow > 0
      ? priceTicks[firstTickInWindow - 1].price
      : launchPrice;

  return {
    price,
    priceChange: comparisonPrice > 0 ? (price / comparisonPrice - 1) * 100 : 0,
    marketCap: price * totalSupply,
    volume: recentEvents.reduce((sum, event) => roundUsdc(sum + event.notional), 0),
    buyers: recentEvents.filter((event) => event.type === "Buy").length,
    sellers: recentEvents.filter((event) => event.type === "Sell").length,
    raisedUsdc,
    targetUsdc,
    progress: targetUsdc > 0 ? Math.min(100, raisedUsdc / targetUsdc * 100) : 0,
    graduated,
    tokensSold: Math.max(0, tokensSold),
    tokenReserve,
    chart,
    trades,
    indexedBlock: indexedBlock.toString(),
    generatedAt: new Date().toISOString(),
  };
}

function getTokenCache(tokenAddress: Address) {
  const key = tokenAddress.toLowerCase();
  const existing = state.tokenCaches.get(key);
  if (existing) return existing;
  if (state.tokenCaches.size >= MAX_TOKEN_CACHES) {
    const oldestKey = state.tokenCaches.keys().next().value as string | undefined;
    if (oldestKey) state.tokenCaches.delete(oldestKey);
  }
  const entry: MarketCacheEntry = { snapshot: null, cachedAt: 0, lastAttemptAt: 0, pending: null };
  state.tokenCaches.set(key, entry);
  return entry;
}

export async function getMarketSnapshot(tokenAddress: Address, forceRefresh = false) {
  const cache = getTokenCache(tokenAddress);
  if (!cache.snapshot) {
    const persisted = await readPersistentSnapshot<MarketSnapshot>(`arcorigin:v4:market:${tokenAddress.toLowerCase()}`);
    if (persisted?.indexedBlock && Array.isArray(persisted.trades)) {
      cache.snapshot = persisted;
      cache.cachedAt = Date.parse(persisted.generatedAt) || 0;
    }
  }
  const now = Date.now();
  const isFresh = cache.snapshot && now - cache.cachedAt < CACHE_TTL_MS;
  const refreshThrottled = cache.snapshot
    && now - cache.lastAttemptAt < (forceRefresh ? FORCE_REFRESH_INTERVAL_MS : MIN_REFRESH_INTERVAL_MS);
  if (isFresh && !forceRefresh) return { snapshot: cache.snapshot, stale: false };
  if (refreshThrottled) return { snapshot: cache.snapshot, stale: now - cache.cachedAt >= CACHE_TTL_MS };
  if (!cache.snapshot && !cache.pending && cache.lastAttemptAt > 0 && now - cache.lastAttemptAt < MIN_REFRESH_INTERVAL_MS) {
    throw new Error("Arc RPC rate limit cooldown is active.");
  }

  if (!cache.pending) {
    cache.lastAttemptAt = now;
    cache.pending = loadMarketSnapshot(tokenAddress, forceRefresh)
      .then((snapshot) => {
        cache.snapshot = snapshot;
        cache.cachedAt = Date.now();
        void writePersistentSnapshot(`arcorigin:v4:market:${tokenAddress.toLowerCase()}`, snapshot);
        return snapshot;
      })
      .finally(() => {
        cache.pending = null;
      });
  }
  try {
    const snapshot = await cache.pending;
    return { snapshot, stale: false };
  } catch (error) {
    if (cache.snapshot) return { snapshot: cache.snapshot, stale: true };
    throw error;
  }
}

export function isMarketRpcError(error: unknown) {
  return isRetryableRpcError(error);
}
