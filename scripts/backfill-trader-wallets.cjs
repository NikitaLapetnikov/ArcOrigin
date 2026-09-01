"use strict";

const { Pool } = require("pg");
const { createClient: createRedisClient } = require("redis");
const { isAddress } = require("viem");
const {
  createArcClient,
  rpcUrls,
  traderFromTransferFlow,
  transferFlowKey,
  withRetry,
} = require("./run-event-indexer.cjs");

const RECENT_EVENTS_KEY = "arcorigin:mainnet:indexer:recent-events";
const MARKET_CACHE_PATTERN = "arcorigin:mainnet:market:*";
const LATEST_BUYS_PATTERN = "arcorigin:mainnet:latest-buys:*";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function normalizeAddress(value) {
  return typeof value === "string" && isAddress(value) ? value.toLowerCase() : null;
}

function collectTransferFlows(rows) {
  const transfersByTransaction = new Map();
  for (const row of rows) {
    const payload = row.payload;
    const tokenAddress = normalizeAddress(row.token_address);
    if (!tokenAddress || !payload || typeof payload !== "object") continue;
    const from = normalizeAddress(payload.from);
    const to = normalizeAddress(payload.to);
    if (!from || !to || typeof payload.value !== "string" || !/^\d+$/.test(payload.value)) continue;
    const key = transferFlowKey(tokenAddress, row.transaction_hash);
    const transfers = transfersByTransaction.get(key) ?? [];
    transfers.push({ from, to, value: payload.value });
    transfersByTransaction.set(key, transfers);
  }
  return transfersByTransaction;
}

async function invalidateAnalyticsCache(redisUrl) {
  if (!redisUrl) return { invalidated: 0, connected: false };
  const redis = createRedisClient({ url: redisUrl, socket: { connectTimeout: 5_000 } });
  redis.on("error", () => undefined);
  await redis.connect();
  let invalidated = 0;
  try {
    for (const pattern of [MARKET_CACHE_PATTERN, LATEST_BUYS_PATTERN]) {
      for await (const result of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
        const keys = Array.isArray(result) ? result : [result];
        if (keys.length === 0) continue;
        invalidated += await redis.del(keys);
      }
    }
    invalidated += await redis.del(RECENT_EVENTS_KEY);
    return { invalidated, connected: true };
  } finally {
    await redis.quit();
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const database = new Pool({
    connectionString: required("DATABASE_URL"),
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 60_000,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const [swapResult, transferResult] = await Promise.all([
      database.query(`
        SELECT id, token_address, pool_address, transaction_hash, payload
          FROM arc_events
         WHERE event_name = 'Swap'
         ORDER BY block_number ASC, log_index ASC
      `),
      database.query(`
        SELECT token_address, transaction_hash, payload
          FROM arc_events
         WHERE event_name = 'Transfer'
         ORDER BY block_number ASC, log_index ASC
      `),
    ]);
    const transfersByTransaction = collectTransferFlows(transferResult.rows);
    const unresolved = [];
    const resolutions = [];
    for (const row of swapResult.rows) {
      const payload = row.payload;
      const tokenAddress = normalizeAddress(row.token_address);
      const poolAddress = normalizeAddress(row.pool_address);
      const currentWallet = normalizeAddress(payload?.wallet);
      if (!tokenAddress || !poolAddress || !currentWallet || (payload.side !== "Buy" && payload.side !== "Sell")) {
        throw new Error(`Stored Swap ${row.id} has an invalid attribution payload.`);
      }
      const transferWallet = traderFromTransferFlow(
        payload.side,
        poolAddress,
        transfersByTransaction.get(transferFlowKey(tokenAddress, row.transaction_hash)),
      );
      const resolution = { id: row.id, transactionHash: row.transaction_hash, currentWallet, wallet: transferWallet };
      resolutions.push(resolution);
      if (!transferWallet) unresolved.push(resolution);
    }

    if (unresolved.length > 0) {
      const publicClient = createArcClient(rpcUrls());
      for (const resolution of unresolved) {
        const transaction = await withRetry(
          () => publicClient.getTransaction({ hash: resolution.transactionHash }),
          3,
        );
        resolution.wallet = normalizeAddress(transaction.from);
      }
    }

    const changes = resolutions.filter((item) => item.wallet && item.wallet !== item.currentWallet);
    const unresolvedCount = resolutions.filter((item) => !item.wallet).length;
    if (unresolvedCount > 0) throw new Error(`${unresolvedCount} Swap events could not be attributed safely.`);
    if (apply && changes.length > 0) {
      const client = await database.connect();
      try {
        await client.query("BEGIN");
        for (const change of changes) {
          await client.query(`
            UPDATE arc_events
               SET payload = jsonb_set(payload, '{wallet}', to_jsonb($2::text), true)
             WHERE id = $1
          `, [change.id, change.wallet]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    const cache = apply ? await invalidateAnalyticsCache(process.env.REDIS_URL?.trim()) : { invalidated: 0, connected: false };
    console.log(JSON.stringify({
      mode: apply ? "apply" : "dry-run",
      swaps: resolutions.length,
      changed: changes.length,
      unchanged: resolutions.length - changes.length,
      unresolved: unresolvedCount,
      cache,
      sample: changes.slice(0, 20).map(({ transactionHash, currentWallet, wallet }) => ({ transactionHash, from: currentWallet, to: wallet })),
    }, null, 2));
  } finally {
    await database.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { collectTransferFlows };
