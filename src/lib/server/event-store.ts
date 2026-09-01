import "server-only";

import { Pool, type PoolConfig } from "pg";
import { formatUnits, getAddress, isAddress, isHash, type Address, type Hash } from "viem";
import type { FactoryLaunch } from "@/lib/onchain/holder-snapshot";

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

export type StoredHolderBalance = {
  address: Address;
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
               name, symbol, launch_block, launch_timestamp, transaction_hash
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
         LIMIT 500
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

export function storedBuybackAmounts(event: StoredBuyback) {
  return {
    usdcSpent: Number(formatUnits(event.quoteSpent, 6)),
    keeperRewardUsdc: Number(formatUnits(event.keeperReward, 6)),
    tokensBurned: Number(formatUnits(event.launchTokensBurned, 18)),
  };
}
