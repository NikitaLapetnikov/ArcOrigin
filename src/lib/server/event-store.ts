import "server-only";

import { Pool, type PoolConfig } from "pg";
import { formatUnits, getAddress, isAddress, isHash, type Address, type Hash } from "viem";
import type { FactoryLaunch } from "@/lib/onchain/holder-snapshot";
import type {
  AnalyticsMarket,
  AnalyticsRange,
  AnalyticsSeriesPoint,
  AnalyticsWindowMetrics,
  ProtocolAnalyticsSnapshot,
} from "@/lib/analytics";

type EventStorePool = Pool | null;

declare global {
  var __arcOriginEventStorePool: EventStorePool | undefined;
}

export type EventStoreCheckpoint = {
  indexedBlock: string;
  indexedBlockHash: Hash;
  generatedAt: string;
};

export type StoredSwap = {
  blockNumber: bigint;
  blockHash: Hash;
  logIndex: number;
  transactionHash: Hash;
  timestamp: number;
  wallet: Address;
  side: "Buy" | "Sell";
  usdc: number;
  tokens: number;
  executionPrice: number;
};

export type StoredPoolQuoteState = {
  sqrtPriceX96: bigint | null;
  checkpoint: EventStoreCheckpoint;
};

export type StoredHolderBalance = {
  address: Address;
  balance: bigint;
};

export type StoredWalletBalance = {
  tokenAddress: Address;
  balance: bigint;
};

export type StoredBuyback = {
  blockNumber: bigint;
  blockHash: Hash;
  transactionHash: Hash;
  timestamp: number;
  keeper: Address;
  quoteSpent: bigint;
  keeperReward: bigint;
  launchTokensBurned: bigint;
};

function poolConfig(): PoolConfig | null {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) return null;
  return {
    connectionString,
    max: 5,
    connectionTimeoutMillis: 1_500,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  };
}

function eventStorePool() {
  if (globalThis.__arcOriginEventStorePool !== undefined) return globalThis.__arcOriginEventStorePool;
  const config = poolConfig();
  if (!config) {
    globalThis.__arcOriginEventStorePool = null;
    return null;
  }
  const pool = new Pool(config);
  pool.on("error", () => undefined);
  globalThis.__arcOriginEventStorePool = pool;
  return pool;
}

function validCheckpointRow(row: Record<string, unknown>): EventStoreCheckpoint | null {
  const indexedBlock = String(row.last_block ?? "");
  const indexedBlockHash = row.last_hash;
  const generatedAt = row.updated_at instanceof Date
    ? row.updated_at.toISOString()
    : String(row.updated_at ?? "");
  if (!/^\d+$/.test(indexedBlock)
    || typeof indexedBlockHash !== "string"
    || !isHash(indexedBlockHash)
    || !Number.isFinite(Date.parse(generatedAt))) return null;
  return { indexedBlock, indexedBlockHash, generatedAt };
}

async function queryCheckpoint(pool: Pool) {
  const result = await pool.query(
    "SELECT last_block, last_hash, updated_at FROM arc_indexer_state WHERE stream = $1",
    ["arc-mainnet"],
  );
  return result.rows[0] ? validCheckpointRow(result.rows[0]) : null;
}

async function optionalQuery<T>(operation: (pool: Pool) => Promise<T>): Promise<T | null> {
  const pool = eventStorePool();
  if (!pool) return null;
  try {
    return await operation(pool);
  } catch {
    // RPC/explorer snapshots remain the safety fallback when Postgres is down
    // or before the first migration has completed.
    return null;
  }
}

export async function getStoredFactoryLaunchIndex(): Promise<{
  launches: FactoryLaunch[];
  checkpoint: EventStoreCheckpoint;
} | null> {
  return optionalQuery(async (pool) => {
    const [checkpoint, result] = await Promise.all([
      queryCheckpoint(pool),
      pool.query(`
        SELECT factory_address, token_address, pool_address, creator_address, position_id,
               name, symbol, automatic_buyback, launch_block, launch_timestamp, transaction_hash
          FROM arc_markets
         ORDER BY launch_block ASC
      `),
    ]);
    if (!checkpoint) return null;
    const launches: FactoryLaunch[] = [];
    for (const row of result.rows) {
      if (!isAddress(row.factory_address)
        || !isAddress(row.token_address)
        || !isAddress(row.pool_address)
        || !isAddress(row.creator_address)
        || !isHash(row.transaction_hash)) return null;
      launches.push({
        factory: getAddress(row.factory_address),
        token: getAddress(row.token_address),
        pool: getAddress(row.pool_address),
        creator: getAddress(row.creator_address),
        positionId: BigInt(row.position_id),
        name: String(row.name),
        symbol: String(row.symbol),
        launchBlock: BigInt(row.launch_block),
        launchedAt: Number(row.launch_timestamp),
        transactionHash: row.transaction_hash,
        automaticBuyback: Boolean(row.automatic_buyback),
      });
    }
    return { launches, checkpoint };
  });
}

export async function getStoredFactoryLaunch(tokenAddress: Address) {
  const stored = await getStoredFactoryLaunchIndex();
  if (!stored) return null;
  const launch = stored.launches.find((item) => item.token.toLowerCase() === tokenAddress.toLowerCase());
  return launch ? { launch, checkpoint: stored.checkpoint } : null;
}

export async function getStoredSwaps(tokenAddress: Address): Promise<{
  swaps: StoredSwap[];
  stats24h: { volume: number; buyers: number; sellers: number; comparisonPrice: number | null };
  checkpoint: EventStoreCheckpoint;
} | null> {
  return optionalQuery(async (pool) => {
    const cutoff = Math.floor(Date.now() / 1_000) - 86_400;
    const [checkpoint, result, statsResult, comparisonResult] = await Promise.all([
      queryCheckpoint(pool),
      pool.query(`
        SELECT block_number, block_hash, log_index, transaction_hash, block_timestamp, payload
          FROM arc_events
         WHERE event_name = 'Swap' AND token_address = $1
         ORDER BY block_number DESC, log_index DESC
      `, [tokenAddress.toLowerCase()]),
      pool.query(`
        SELECT
          COALESCE(SUM((payload->>'usdc')::double precision), 0) AS volume,
          COUNT(*) FILTER (WHERE payload->>'side' = 'Buy') AS buyers,
          COUNT(*) FILTER (WHERE payload->>'side' = 'Sell') AS sellers
        FROM arc_events
        WHERE event_name = 'Swap' AND token_address = $1 AND block_timestamp >= $2
      `, [tokenAddress.toLowerCase(), cutoff]),
      pool.query(`
        SELECT payload->>'executionPrice' AS execution_price
          FROM arc_events
         WHERE event_name = 'Swap' AND token_address = $1 AND block_timestamp < $2
         ORDER BY block_number DESC, log_index DESC
         LIMIT 1
      `, [tokenAddress.toLowerCase(), cutoff]),
    ]);
    if (!checkpoint) return null;
    const swaps: StoredSwap[] = [];
    for (const row of result.rows.reverse()) {
      const payload = row.payload as Record<string, unknown>;
      if (!isHash(row.block_hash)
        || !isHash(row.transaction_hash)
        || typeof payload.wallet !== "string"
        || !isAddress(payload.wallet)
        || (payload.side !== "Buy" && payload.side !== "Sell")) return null;
      const usdc = Number(payload.usdc);
      const tokens = Number(payload.tokens);
      const executionPrice = Number(payload.executionPrice);
      if (![usdc, tokens, executionPrice].every(Number.isFinite) || tokens <= 0) return null;
      swaps.push({
        blockNumber: BigInt(row.block_number),
        blockHash: row.block_hash,
        logIndex: Number(row.log_index),
        transactionHash: row.transaction_hash,
        timestamp: Number(row.block_timestamp),
        wallet: getAddress(payload.wallet),
        side: payload.side,
        usdc,
        tokens,
        executionPrice,
      });
    }
    const comparisonPrice = comparisonResult.rows[0]
      ? Number(comparisonResult.rows[0].execution_price)
      : null;
    return {
      swaps,
      checkpoint,
      stats24h: {
        volume: Number(statsResult.rows[0]?.volume ?? 0),
        buyers: Number(statsResult.rows[0]?.buyers ?? 0),
        sellers: Number(statsResult.rows[0]?.sellers ?? 0),
        comparisonPrice: Number.isFinite(comparisonPrice) && comparisonPrice! > 0 ? comparisonPrice : null,
      },
    };
  });
}

export async function getStoredPoolQuoteState(tokenAddress: Address): Promise<StoredPoolQuoteState | null> {
  return optionalQuery(async (pool) => {
    const [checkpoint, result] = await Promise.all([
      queryCheckpoint(pool),
      pool.query(`
        SELECT payload->>'sqrtPriceX96' AS sqrt_price_x96
          FROM arc_events
         WHERE event_name = 'Swap' AND token_address = $1
         ORDER BY block_number DESC, log_index DESC
         LIMIT 1
      `, [tokenAddress.toLowerCase()]),
    ]);
    if (!checkpoint) return null;
    const rawSqrtPrice = result.rows[0]?.sqrt_price_x96;
    if (rawSqrtPrice === undefined || rawSqrtPrice === null) {
      return { sqrtPriceX96: null, checkpoint };
    }
    const normalized = String(rawSqrtPrice);
    if (!/^\d+$/.test(normalized)) return null;
    const sqrtPriceX96 = BigInt(normalized);
    if (sqrtPriceX96 <= 0n) return null;
    return { sqrtPriceX96, checkpoint };
  });
}

export async function getStoredHolderBalances(tokenAddress: Address): Promise<{
  balances: StoredHolderBalance[];
  checkpoint: EventStoreCheckpoint;
} | null> {
  return optionalQuery(async (pool) => {
    const [checkpoint, result] = await Promise.all([
      queryCheckpoint(pool),
      pool.query(`
        SELECT holder_address, balance
          FROM arc_holder_balances
         WHERE token_address = $1 AND balance > 0
         ORDER BY balance DESC
      `, [tokenAddress.toLowerCase()]),
    ]);
    if (!checkpoint) return null;
    const balances: StoredHolderBalance[] = [];
    for (const row of result.rows) {
      if (!isAddress(row.holder_address)) return null;
      balances.push({ address: getAddress(row.holder_address), balance: BigInt(row.balance) });
    }
    return { balances, checkpoint };
  });
}

export async function getStoredTokenBalance(tokenAddress: Address, holderAddress: Address): Promise<{
  balance: bigint;
  checkpoint: EventStoreCheckpoint;
} | null> {
  return optionalQuery(async (pool) => {
    const [checkpoint, result] = await Promise.all([
      queryCheckpoint(pool),
      pool.query(`
        SELECT balance
          FROM arc_holder_balances
         WHERE token_address = $1 AND holder_address = $2
         LIMIT 1
      `, [tokenAddress.toLowerCase(), holderAddress.toLowerCase()]),
    ]);
    if (!checkpoint) return null;
    const rawBalance = result.rows[0]?.balance;
    const balance = rawBalance === undefined ? 0n : BigInt(rawBalance);
    if (balance < 0n) return null;
    return { balance, checkpoint };
  });
}

export async function getStoredWalletBalances(holderAddress: Address): Promise<{
  balances: StoredWalletBalance[];
  checkpoint: EventStoreCheckpoint;
} | null> {
  return optionalQuery(async (pool) => {
    const [checkpoint, result] = await Promise.all([
      queryCheckpoint(pool),
      pool.query(`
        SELECT token_address, balance
          FROM arc_holder_balances
         WHERE holder_address = $1 AND balance > 0
         ORDER BY token_address ASC
      `, [holderAddress.toLowerCase()]),
    ]);
    if (!checkpoint) return null;
    const balances: StoredWalletBalance[] = [];
    for (const row of result.rows) {
      if (!isAddress(row.token_address)) return null;
      const balance = BigInt(row.balance);
      if (balance <= 0n) continue;
      balances.push({ tokenAddress: getAddress(row.token_address), balance });
    }
    return { balances, checkpoint };
  });
}

export async function getStoredBuybacks(tokenAddress: Address): Promise<{
  events: StoredBuyback[];
  checkpoint: EventStoreCheckpoint;
} | null> {
  return optionalQuery(async (pool) => {
    const [checkpoint, result] = await Promise.all([
      queryCheckpoint(pool),
      pool.query(`
        SELECT block_number, block_hash, transaction_hash, block_timestamp, payload
          FROM arc_events
         WHERE event_name = 'BuybackExecuted' AND token_address = $1
         ORDER BY block_number ASC, log_index ASC
      `, [tokenAddress.toLowerCase()]),
    ]);
    if (!checkpoint) return null;
    const events: StoredBuyback[] = [];
    for (const row of result.rows) {
      const payload = row.payload as Record<string, unknown>;
      if (!isHash(row.block_hash)
        || !isHash(row.transaction_hash)
        || typeof payload.keeper !== "string"
        || !isAddress(payload.keeper)) return null;
      events.push({
        blockNumber: BigInt(row.block_number),
        blockHash: row.block_hash,
        transactionHash: row.transaction_hash,
        timestamp: Number(row.block_timestamp),
        keeper: getAddress(payload.keeper),
        quoteSpent: BigInt(String(payload.quoteSpent)),
        keeperReward: BigInt(String(payload.keeperReward)),
        launchTokensBurned: BigInt(String(payload.launchTokensBurned)),
      });
    }
    return { events, checkpoint };
  });
}

export async function getEventStoreStatus() {
  const configured = Boolean(process.env.DATABASE_URL?.trim());
  if (!configured) {
    return { configured: false, reachable: false, latencyMs: null, indexedBlock: null, indexedBlockHash: null, ageSeconds: null };
  }
  const startedAt = Date.now();
  const result = await optionalQuery(async (pool) => {
    const checkpoint = await queryCheckpoint(pool);
    return { checkpoint };
  });
  if (!result) {
    return { configured: true, reachable: false, latencyMs: Date.now() - startedAt, indexedBlock: null, indexedBlockHash: null, ageSeconds: null };
  }
  const generatedAt = result.checkpoint ? Date.parse(result.checkpoint.generatedAt) : NaN;
  return {
    configured: true,
    reachable: true,
    latencyMs: Date.now() - startedAt,
    indexedBlock: result.checkpoint?.indexedBlock ?? null,
    indexedBlockHash: result.checkpoint?.indexedBlockHash ?? null,
    ageSeconds: Number.isFinite(generatedAt) ? Math.max(0, Math.floor((Date.now() - generatedAt) / 1_000)) : null,
  };
}

const ANALYTICS_RANGE_SECONDS: Record<AnalyticsRange, number> = {
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
  all: 0,
};

const ANALYTICS_BUCKET_SECONDS: Record<AnalyticsRange, number> = {
  "24h": 60 * 60,
  "7d": 24 * 60 * 60,
  "30d": 24 * 60 * 60,
  all: 24 * 60 * 60,
};

const ANALYTICS_POINT_COUNT: Record<AnalyticsRange, number> = {
  "24h": 24,
  "7d": 7,
  "30d": 30,
  all: 60,
};

function numeric(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function integer(value: unknown) {
  return Math.max(0, Math.trunc(numeric(value)));
}

function rawUnits(value: unknown, decimals: number) {
  const raw = typeof value === "string" ? value : String(value ?? "0");
  try {
    return Number(formatUnits(BigInt(raw.split(".")[0] || "0"), decimals));
  } catch {
    return 0;
  }
}

function windowMetrics(swapRow: Record<string, unknown>, launchRow: Record<string, unknown>): AnalyticsWindowMetrics {
  return {
    volumeUsdc: numeric(swapRow.volume),
    trades: integer(swapRow.trades),
    traders: integer(swapRow.traders),
    launches: integer(launchRow.launches),
    creators: integer(launchRow.creators),
    automaticBuybackLaunches: integer(launchRow.automatic_buyback_launches),
  };
}

function completeAnalyticsSeries({
  rows,
  range,
  now,
  bucketSeconds,
}: {
  rows: AnalyticsSeriesPoint[];
  range: AnalyticsRange;
  now: number;
  bucketSeconds: number;
}) {
  const end = Math.floor(now / bucketSeconds) * bucketSeconds;
  const configuredCount = ANALYTICS_POINT_COUNT[range];
  const firstStored = rows[0]?.timestamp ?? end;
  const earliestAllowed = end - (configuredCount - 1) * bucketSeconds;
  const start = range === "all" ? Math.max(firstStored, earliestAllowed) : earliestAllowed;
  const byTimestamp = new Map(rows.map((point) => [point.timestamp, point]));
  const complete: AnalyticsSeriesPoint[] = [];
  for (let timestamp = start; timestamp <= end; timestamp += bucketSeconds) {
    complete.push(byTimestamp.get(timestamp) ?? {
      timestamp,
      volumeUsdc: 0,
      trades: 0,
      launches: 0,
      buybackSpentUsdc: 0,
    });
  }
  return complete;
}

/**
 * Reads one coherent protocol-wide analytics snapshot from the canonical
 * Postgres event store. The RPC snapshots remain the product fallback for
 * token pages; analytics intentionally stays indexer-backed so it never fans
 * out into one RPC scan per market.
 */
export async function getStoredProtocolAnalytics(
  range: AnalyticsRange,
): Promise<ProtocolAnalyticsSnapshot | null> {
  return optionalQuery(async (pool) => {
    const now = Math.floor(Date.now() / 1_000);
    const rangeSeconds = ANALYTICS_RANGE_SECONDS[range];
    const cutoff = rangeSeconds === 0 ? 0 : now - rangeSeconds;
    const bucketSeconds = ANALYTICS_BUCKET_SECONDS[range];
    const [
      checkpoint,
      rangeSwaps,
      allSwaps,
      rangeLaunches,
      allLaunches,
      holders,
      buybacks,
      seriesRows,
      marketRows,
    ] = await Promise.all([
      queryCheckpoint(pool),
      pool.query(`
        SELECT
          COALESCE(SUM((payload->>'usdc')::double precision), 0) AS volume,
          COUNT(*) AS trades,
          COUNT(DISTINCT payload->>'wallet') AS traders,
          COALESCE(SUM((payload->>'usdc')::double precision)
            FILTER (WHERE market.automatic_buyback), 0) AS automatic_buyback_volume,
          COALESCE(SUM((payload->>'usdc')::double precision)
            FILTER (WHERE NOT market.automatic_buyback), 0) AS standard_volume
        FROM arc_events event
        JOIN arc_markets market ON market.token_address = event.token_address
        WHERE event.event_name = 'Swap' AND event.block_timestamp >= $1
      `, [cutoff]),
      pool.query(`
        SELECT
          COALESCE(SUM((payload->>'usdc')::double precision), 0) AS volume,
          COUNT(*) AS trades,
          COUNT(DISTINCT payload->>'wallet') AS traders
        FROM arc_events
        WHERE event_name = 'Swap'
      `),
      pool.query(`
        SELECT
          COUNT(*) AS launches,
          COUNT(DISTINCT creator_address) AS creators,
          COUNT(*) FILTER (WHERE automatic_buyback) AS automatic_buyback_launches
        FROM arc_markets
        WHERE launch_timestamp >= $1
      `, [cutoff]),
      pool.query(`
        SELECT
          COUNT(*) AS launches,
          COUNT(DISTINCT creator_address) AS creators,
          COUNT(*) FILTER (WHERE automatic_buyback) AS automatic_buyback_launches
        FROM arc_markets
      `),
      pool.query(`
        SELECT COUNT(DISTINCT balance.holder_address) AS holders
        FROM arc_holder_balances balance
        JOIN arc_markets market ON market.token_address = balance.token_address
        WHERE balance.balance > 0
          AND balance.holder_address <> market.pool_address
          AND balance.holder_address <> '0x0000000000000000000000000000000000000000'
      `),
      pool.query(`
        SELECT
          COUNT(*) AS executions,
          COALESCE(SUM((payload->>'quoteSpent')::numeric), 0) AS quote_spent,
          COALESCE(SUM((payload->>'launchTokensBurned')::numeric), 0) AS tokens_burned
        FROM arc_events
        WHERE event_name = 'BuybackExecuted' AND block_timestamp >= $1
      `, [cutoff]),
      pool.query(`
        SELECT bucket, SUM(volume) AS volume, SUM(trades) AS trades,
               SUM(launches) AS launches, SUM(buyback_spent) AS buyback_spent
        FROM (
          SELECT FLOOR(block_timestamp / $2)::bigint * $2 AS bucket,
                 SUM((payload->>'usdc')::double precision) AS volume,
                 COUNT(*) AS trades, 0::bigint AS launches, 0::numeric AS buyback_spent
          FROM arc_events
          WHERE event_name = 'Swap' AND block_timestamp >= $1
          GROUP BY 1
          UNION ALL
          SELECT FLOOR(launch_timestamp / $2)::bigint * $2 AS bucket,
                 0::double precision AS volume, 0::bigint AS trades,
                 COUNT(*) AS launches, 0::numeric AS buyback_spent
          FROM arc_markets
          WHERE launch_timestamp >= $1
          GROUP BY 1
          UNION ALL
          SELECT FLOOR(block_timestamp / $2)::bigint * $2 AS bucket,
                 0::double precision AS volume, 0::bigint AS trades,
                 0::bigint AS launches,
                 SUM((payload->>'quoteSpent')::numeric) AS buyback_spent
          FROM arc_events
          WHERE event_name = 'BuybackExecuted' AND block_timestamp >= $1
          GROUP BY 1
        ) activity
        GROUP BY bucket
        ORDER BY bucket DESC
        LIMIT 60
      `, [cutoff, bucketSeconds]),
      pool.query(`
        SELECT market.token_address, market.name, market.symbol,
               market.automatic_buyback,
               COALESCE(SUM((event.payload->>'usdc')::double precision), 0) AS volume,
               COUNT(event.id) AS trades,
               COUNT(DISTINCT event.payload->>'wallet') AS traders
        FROM arc_markets market
        LEFT JOIN arc_events event ON event.token_address = market.token_address
          AND event.event_name = 'Swap' AND event.block_timestamp >= $1
        GROUP BY market.token_address, market.name, market.symbol, market.automatic_buyback
        ORDER BY volume DESC, trades DESC, market.launch_block DESC
        LIMIT 8
      `, [cutoff]),
    ]);
    if (!checkpoint) return null;

    const rangeSwapRow = (rangeSwaps.rows[0] ?? {}) as Record<string, unknown>;
    const allSwapRow = (allSwaps.rows[0] ?? {}) as Record<string, unknown>;
    const rangeLaunchRow = (rangeLaunches.rows[0] ?? {}) as Record<string, unknown>;
    const allLaunchRow = (allLaunches.rows[0] ?? {}) as Record<string, unknown>;
    const buybackRow = (buybacks.rows[0] ?? {}) as Record<string, unknown>;
    const rangeMetrics = windowMetrics(rangeSwapRow, rangeLaunchRow);
    const allTimeMetrics = windowMetrics(allSwapRow, allLaunchRow);
    const automaticBuybackVolume = numeric(rangeSwapRow.automatic_buyback_volume);
    const standardVolume = numeric(rangeSwapRow.standard_volume);

    const sparseSeries: AnalyticsSeriesPoint[] = seriesRows.rows.slice().reverse().map((row) => ({
      timestamp: integer(row.bucket),
      volumeUsdc: numeric(row.volume),
      trades: integer(row.trades),
      launches: integer(row.launches),
      buybackSpentUsdc: rawUnits(row.buyback_spent, 6),
    }));
    const series = completeAnalyticsSeries({ rows: sparseSeries, range, now, bucketSeconds });
    const markets: AnalyticsMarket[] = marketRows.rows.map((row) => ({
      address: String(row.token_address),
      name: String(row.name),
      symbol: String(row.symbol),
      automaticBuyback: Boolean(row.automatic_buyback),
      volumeUsdc: numeric(row.volume),
      trades: integer(row.trades),
      traders: integer(row.traders),
    }));

    return {
      schemaVersion: 1,
      range,
      metrics: rangeMetrics,
      allTime: {
        ...allTimeMetrics,
        holders: integer(holders.rows[0]?.holders),
      },
      economics: {
        feeEquivalentUsdc: rangeMetrics.volumeUsdc * 0.01,
        creatorEarningsEquivalentUsdc: standardVolume * 0.007,
        protocolRevenueEquivalentUsdc: rangeMetrics.volumeUsdc * 0.003,
        buybackAllocationEquivalentUsdc: automaticBuybackVolume * 0.007,
        buybackSpentUsdc: rawUnits(buybackRow.quote_spent, 6),
        tokensBurned: rawUnits(buybackRow.tokens_burned, 18),
        buybackExecutions: integer(buybackRow.executions),
      },
      launchModes: {
        standard: Math.max(0, allTimeMetrics.launches - allTimeMetrics.automaticBuybackLaunches),
        automaticBuyback: allTimeMetrics.automaticBuybackLaunches,
      },
      series,
      markets,
      indexedBlock: checkpoint.indexedBlock,
      indexedBlockHash: checkpoint.indexedBlockHash,
      generatedAt: checkpoint.generatedAt,
    };
  });
}

export function storedBuybackAmounts(event: StoredBuyback) {
  return {
    usdcSpent: Number(formatUnits(event.quoteSpent, 6)),
    keeperRewardUsdc: Number(formatUnits(event.keeperReward, 6)),
    tokensBurned: Number(formatUnits(event.launchTokensBurned, 18)),
  };
}
