"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { createClient: createRedisClient } = require("redis");
const {
  createPublicClient,
  defineChain,
  fallback,
  formatUnits,
  http,
  parseAbiItem,
} = require("viem");

const STREAM = "arc-mainnet";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const STATUS_KEY = "arcorigin:mainnet:indexer:status";
const STATUS_CHANNEL = "arcorigin:mainnet:indexer-status";
const RECENT_EVENTS_KEY = "arcorigin:mainnet:indexer:recent-events";
const EVENT_CHANNEL = "arcorigin:mainnet:events";

const tokenLaunchedEvent = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed pool, address indexed creator, string name, string symbol, uint256 positionId)",
);
const automaticBuybackConfiguredEvent = parseAbiItem(
  "event AutomaticBuybackConfigured(address indexed token, uint256 indexed positionId, bool enabled)",
);
const swapEvent = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
const buybackExecutedEvent = parseAbiItem(
  "event BuybackExecuted(uint256 indexed positionId, address indexed keeper, uint256 quoteSpent, uint256 keeperReward, uint256 launchTokensBurned, uint256 remainingQuoteReserve)",
);
const liquidityLockerAbi = [{
  type: "function",
  name: "liquidityLocker",
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "address" }],
}];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveInteger(name, fallbackValue) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallbackValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function normalizeHex(value) {
  return value.toLowerCase();
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));
}

function eventId(log) {
  return `${normalizeHex(log.transactionHash)}:${log.logIndex}`;
}

function tokenIsToken0(tokenAddress, usdcAddress) {
  return BigInt(tokenAddress) < BigInt(usdcAddress);
}

function priceFromSqrt(sqrtPriceX96, isToken0) {
  const normalized = Number(sqrtPriceX96) / 2 ** 96;
  const token1PerToken0 = normalized * normalized;
  const value = isToken0 ? token1PerToken0 * 1e12 : 1e12 / token1PerToken0;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function swapPayload(args, market, usdcAddress) {
  const isToken0 = tokenIsToken0(market.tokenAddress, usdcAddress);
  const tokenDelta = isToken0 ? args.amount0 : args.amount1;
  const usdcDelta = isToken0 ? args.amount1 : args.amount0;
  if (tokenDelta === 0n || usdcDelta === 0n || (tokenDelta < 0n) === (usdcDelta < 0n)) return null;
  const usdc = Number(formatUnits(usdcDelta < 0n ? -usdcDelta : usdcDelta, 6));
  const tokens = Number(formatUnits(tokenDelta < 0n ? -tokenDelta : tokenDelta, 18));
  if (!Number.isFinite(usdc) || !Number.isFinite(tokens) || tokens <= 0) return null;
  return {
    sender: normalizeHex(args.sender),
    recipient: normalizeHex(args.recipient),
    wallet: normalizeHex(args.recipient || args.sender),
    side: tokenDelta < 0n ? "Buy" : "Sell",
    amount0: args.amount0.toString(),
    amount1: args.amount1.toString(),
    sqrtPriceX96: args.sqrtPriceX96.toString(),
    tick: Number(args.tick),
    usdc,
    tokens,
    price: usdc / tokens,
    executionPrice: priceFromSqrt(args.sqrtPriceX96, isToken0),
  };
}

function transferFlowKey(tokenAddress, transactionHash) {
  return `${normalizeHex(tokenAddress)}:${normalizeHex(transactionHash)}`;
}

function traderFromTransferFlow(side, poolAddress, transfers) {
  if (side !== "Buy" && side !== "Sell") return null;
  const deltas = new Map();
  for (const transfer of transfers ?? []) {
    if (!transfer || typeof transfer.from !== "string" || typeof transfer.to !== "string") continue;
    let value;
    try {
      value = BigInt(transfer.value);
    } catch {
      continue;
    }
    if (value <= 0n) continue;
    const from = normalizeHex(transfer.from);
    const to = normalizeHex(transfer.to);
    deltas.set(from, (deltas.get(from) ?? 0n) - value);
    deltas.set(to, (deltas.get(to) ?? 0n) + value);
  }
  const pool = normalizeHex(poolAddress);
  const candidates = [...deltas.entries()].filter(([address, delta]) => (
    address !== ZERO_ADDRESS
      && address !== pool
      && (side === "Buy" ? delta > 0n : delta < 0n)
  ));
  candidates.sort(([leftAddress, leftDelta], [rightAddress, rightDelta]) => {
    const leftMagnitude = leftDelta < 0n ? -leftDelta : leftDelta;
    const rightMagnitude = rightDelta < 0n ? -rightDelta : rightDelta;
    if (leftMagnitude !== rightMagnitude) return leftMagnitude > rightMagnitude ? -1 : 1;
    return leftAddress.localeCompare(rightAddress);
  });
  return candidates[0]?.[0] ?? null;
}

function rpcUrls() {
  const urls = [
    process.env.ARC_MAINNET_RPC_URL,
    process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL,
    ...(process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_FALLBACK_URLS ?? "").split(","),
  ].map((value) => value?.trim()).filter(Boolean);
  const unique = [...new Set(urls)];
  if (unique.length === 0) throw new Error("At least one Arc RPC URL is required.");
  return unique;
}

function createArcClient(urls) {
  const chain = defineChain({
    id: 5_042,
    name: "Arc",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: urls } },
  });
  return createPublicClient({
    chain,
    transport: fallback(urls.map((url) => http(url, { retryCount: 0, timeout: 10_000 })), {
      rank: false,
      retryCount: 0,
    }),
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withRetry(operation, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(Math.min(8_000, attempt * 1_000));
    }
  }
  throw lastError;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function runMigration(database) {
  const migrationDirectory = path.join(process.cwd(), "deploy/postgres");
  const migrationFiles = fs.readdirSync(migrationDirectory)
    .filter((fileName) => /^\d+_[a-z0-9_]+\.sql$/.test(fileName))
    .sort();
  if (migrationFiles.length === 0) throw new Error("No Postgres migrations were found.");
  for (const fileName of migrationFiles) {
    await database.query(fs.readFileSync(path.join(migrationDirectory, fileName), "utf8"));
  }
}

async function loadState(database, fromBlock) {
  const result = await database.query(
    "SELECT last_block, last_hash FROM arc_indexer_state WHERE stream = $1",
    [STREAM],
  );
  if (result.rowCount === 0) return { lastBlock: fromBlock - 1n, lastHash: null };
  return { lastBlock: BigInt(result.rows[0].last_block), lastHash: result.rows[0].last_hash };
}

async function loadMarkets(database) {
  const result = await database.query(`
    SELECT token_address, pool_address, creator_address, position_id, launch_block,
           launch_timestamp, transaction_hash, name, symbol, automatic_buyback
      FROM arc_markets
     ORDER BY launch_block ASC
  `);
  return result.rows.map((row) => ({
    tokenAddress: row.token_address,
    poolAddress: row.pool_address,
    creatorAddress: row.creator_address,
    positionId: String(row.position_id),
    launchBlock: BigInt(row.launch_block),
    launchTimestamp: Number(row.launch_timestamp),
    transactionHash: row.transaction_hash,
    name: row.name,
    symbol: row.symbol,
    automaticBuyback: row.automatic_buyback,
  }));
}

async function fetchBlockMap(publicClient, logs, finalBlock) {
  const numbers = new Set(logs.map((log) => BigInt(log.blockNumber).toString()));
  numbers.add(finalBlock.toString());
  const map = new Map();
  for (const batch of chunks([...numbers], 8)) {
    const blocks = await Promise.all(batch.map((number) => withRetry(
      () => publicClient.getBlock({ blockNumber: BigInt(number) }),
      3,
    )));
    for (const block of blocks) {
      map.set(block.number.toString(), {
        number: block.number,
        hash: normalizeHex(block.hash),
        timestamp: Number(block.timestamp),
      });
    }
  }
  return map;
}

function baseEvent(log, block, eventName, fields, payload) {
  return {
    id: eventId(log),
    eventName,
    contractAddress: normalizeHex(log.address),
    tokenAddress: fields.tokenAddress ? normalizeHex(fields.tokenAddress) : null,
    poolAddress: fields.poolAddress ? normalizeHex(fields.poolAddress) : null,
    positionId: fields.positionId === undefined || fields.positionId === null ? null : String(fields.positionId),
    transactionHash: normalizeHex(log.transactionHash),
    logIndex: Number(log.logIndex),
    blockNumber: block.number,
    blockHash: block.hash,
    blockTimestamp: block.timestamp,
    payload: jsonSafe(payload),
  };
}

async function readRange(publicClient, database, config, fromBlock, toBlock) {
  const [launchLogs, configLogs] = await Promise.all([
    withRetry(() => publicClient.getLogs({ address: config.factory, event: tokenLaunchedEvent, fromBlock, toBlock })),
    withRetry(() => publicClient.getLogs({ address: config.factory, event: automaticBuybackConfiguredEvent, fromBlock, toBlock })),
  ]);
  const storedMarkets = await loadMarkets(database);
  const marketsByToken = new Map(storedMarkets.map((market) => [market.tokenAddress, market]));
  const configsByToken = new Map(configLogs.map((log) => [normalizeHex(log.args.token), Boolean(log.args.enabled)]));
  for (const log of launchLogs) {
    const tokenAddress = normalizeHex(log.args.token);
    marketsByToken.set(tokenAddress, {
      tokenAddress,
      poolAddress: normalizeHex(log.args.pool),
      creatorAddress: normalizeHex(log.args.creator),
      positionId: String(log.args.positionId),
      launchBlock: BigInt(log.blockNumber),
      launchTimestamp: 0,
      transactionHash: normalizeHex(log.transactionHash),
      name: log.args.name,
      symbol: log.args.symbol,
      automaticBuyback: configsByToken.get(tokenAddress) ?? false,
    });
  }
  const markets = [...marketsByToken.values()];
  const poolMap = new Map(markets.map((market) => [market.poolAddress, market]));
  const tokenMap = new Map(markets.map((market) => [market.tokenAddress, market]));
  const positionMap = new Map(markets.map((market) => [market.positionId, market]));
  const poolLogs = [];
  const transferLogs = [];
  for (const addresses of chunks(markets.map((market) => market.poolAddress), config.addressChunkSize)) {
    poolLogs.push(...await withRetry(() => publicClient.getLogs({ address: addresses, event: swapEvent, fromBlock, toBlock })));
  }
  for (const addresses of chunks(markets.map((market) => market.tokenAddress), config.addressChunkSize)) {
    transferLogs.push(...await withRetry(() => publicClient.getLogs({ address: addresses, event: transferEvent, fromBlock, toBlock })));
  }
  const buybackLogs = await withRetry(() => publicClient.getLogs({
    address: config.locker,
    event: buybackExecutedEvent,
    fromBlock,
    toBlock,
  }));
  const allLogs = [...launchLogs, ...configLogs, ...poolLogs, ...transferLogs, ...buybackLogs];
  const blocks = await fetchBlockMap(publicClient, allLogs, toBlock);
  const events = [];
  const transfersByTransaction = new Map();
  for (const log of transferLogs) {
    const tokenAddress = normalizeHex(log.address);
    const key = transferFlowKey(tokenAddress, log.transactionHash);
    const transfers = transfersByTransaction.get(key) ?? [];
    transfers.push({
      from: normalizeHex(log.args.from),
      to: normalizeHex(log.args.to),
      value: String(log.args.value),
    });
    transfersByTransaction.set(key, transfers);
  }
  for (const log of launchLogs) {
    const block = blocks.get(BigInt(log.blockNumber).toString());
    const tokenAddress = normalizeHex(log.args.token);
    const market = marketsByToken.get(tokenAddress);
    market.launchTimestamp = block.timestamp;
    events.push(baseEvent(log, block, "TokenLaunched", {
      tokenAddress,
      poolAddress: log.args.pool,
      positionId: log.args.positionId,
    }, {
      token: tokenAddress,
      pool: normalizeHex(log.args.pool),
      creator: normalizeHex(log.args.creator),
      name: log.args.name,
      symbol: log.args.symbol,
      positionId: String(log.args.positionId),
      automaticBuyback: configsByToken.get(tokenAddress) ?? false,
    }));
  }
  for (const log of configLogs) {
    const block = blocks.get(BigInt(log.blockNumber).toString());
    const market = tokenMap.get(normalizeHex(log.args.token));
    events.push(baseEvent(log, block, "AutomaticBuybackConfigured", {
      tokenAddress: log.args.token,
      poolAddress: market?.poolAddress,
      positionId: log.args.positionId,
    }, { token: normalizeHex(log.args.token), positionId: String(log.args.positionId), enabled: Boolean(log.args.enabled) }));
  }
  for (const log of poolLogs) {
    const market = poolMap.get(normalizeHex(log.address));
    if (!market) continue;
    const payload = swapPayload(log.args, market, config.usdc);
    if (!payload) continue;
    payload.wallet = traderFromTransferFlow(
      payload.side,
      market.poolAddress,
      transfersByTransaction.get(transferFlowKey(market.tokenAddress, log.transactionHash)),
    ) ?? payload.wallet;
    events.push(baseEvent(log, blocks.get(BigInt(log.blockNumber).toString()), "Swap", {
      tokenAddress: market.tokenAddress,
      poolAddress: market.poolAddress,
      positionId: market.positionId,
    }, payload));
  }
  for (const log of transferLogs) {
    const market = tokenMap.get(normalizeHex(log.address));
    if (!market) continue;
    events.push(baseEvent(log, blocks.get(BigInt(log.blockNumber).toString()), "Transfer", {
      tokenAddress: market.tokenAddress,
      poolAddress: market.poolAddress,
      positionId: market.positionId,
    }, {
      from: normalizeHex(log.args.from),
      to: normalizeHex(log.args.to),
      value: String(log.args.value),
    }));
  }
  for (const log of buybackLogs) {
    const market = positionMap.get(String(log.args.positionId));
    if (!market) continue;
    events.push(baseEvent(log, blocks.get(BigInt(log.blockNumber).toString()), "BuybackExecuted", {
      tokenAddress: market.tokenAddress,
      poolAddress: market.poolAddress,
      positionId: market.positionId,
    }, {
      positionId: String(log.args.positionId),
      keeper: normalizeHex(log.args.keeper),
      quoteSpent: String(log.args.quoteSpent),
      keeperReward: String(log.args.keeperReward),
      launchTokensBurned: String(log.args.launchTokensBurned),
      remainingQuoteReserve: String(log.args.remainingQuoteReserve),
      usdcSpent: Number(formatUnits(log.args.quoteSpent, 6)),
      keeperRewardUsdc: Number(formatUnits(log.args.keeperReward, 6)),
      tokensBurned: Number(formatUnits(log.args.launchTokensBurned, 18)),
    }));
  }
  events.sort((left, right) => left.blockNumber === right.blockNumber
    ? left.logIndex - right.logIndex
    : left.blockNumber < right.blockNumber ? -1 : 1);
  return { events, blocks, finalBlock: blocks.get(toBlock.toString()), markets };
}

async function upsertBalance(client, tokenAddress, holderAddress, delta, blockNumber) {
  if (holderAddress === ZERO_ADDRESS || delta === 0n) return;
  await client.query(`
    INSERT INTO arc_holder_balances (token_address, holder_address, balance, updated_block)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (token_address, holder_address) DO UPDATE
      SET balance = arc_holder_balances.balance + EXCLUDED.balance,
          updated_block = GREATEST(arc_holder_balances.updated_block, EXCLUDED.updated_block)
  `, [tokenAddress, holderAddress, delta.toString(), blockNumber.toString()]);
}

async function storeRange(database, range, config) {
  const client = await database.connect();
  const published = [];
  try {
    await client.query("BEGIN");
    for (const block of range.blocks.values()) {
      await client.query(`
        INSERT INTO arc_blocks (block_number, block_hash, block_timestamp)
        VALUES ($1, $2, $3)
        ON CONFLICT (block_number) DO UPDATE
          SET block_hash = EXCLUDED.block_hash, block_timestamp = EXCLUDED.block_timestamp
      `, [block.number.toString(), block.hash, block.timestamp]);
    }
    for (const event of range.events) {
      const inserted = await client.query(`
        INSERT INTO arc_events (
          id, event_name, contract_address, token_address, pool_address, position_id,
          transaction_hash, log_index, block_number, block_hash, block_timestamp, payload
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `, [
        event.id, event.eventName, event.contractAddress, event.tokenAddress, event.poolAddress,
        event.positionId, event.transactionHash, event.logIndex, event.blockNumber.toString(),
        event.blockHash, event.blockTimestamp, event.payload,
      ]);
      if (inserted.rowCount === 0) continue;
      if (event.eventName === "TokenLaunched") {
        await client.query(`
          INSERT INTO arc_markets (
            token_address, factory_address, pool_address, creator_address, name, symbol,
            position_id, automatic_buyback, launch_block, launch_timestamp, transaction_hash
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (token_address) DO UPDATE SET
            pool_address = EXCLUDED.pool_address,
            creator_address = EXCLUDED.creator_address,
            name = EXCLUDED.name,
            symbol = EXCLUDED.symbol,
            position_id = EXCLUDED.position_id,
            automatic_buyback = EXCLUDED.automatic_buyback,
            launch_block = EXCLUDED.launch_block,
            launch_timestamp = EXCLUDED.launch_timestamp,
            transaction_hash = EXCLUDED.transaction_hash
        `, [
          event.tokenAddress, config.factory, event.poolAddress, event.payload.creator,
          event.payload.name, event.payload.symbol, event.positionId,
          Boolean(event.payload.automaticBuyback), event.blockNumber.toString(),
          event.blockTimestamp, event.transactionHash,
        ]);
      } else if (event.eventName === "AutomaticBuybackConfigured") {
        await client.query(
          "UPDATE arc_markets SET automatic_buyback = $2 WHERE token_address = $1",
          [event.tokenAddress, Boolean(event.payload.enabled)],
        );
      } else if (event.eventName === "Transfer") {
        const value = BigInt(event.payload.value);
        await upsertBalance(client, event.tokenAddress, event.payload.from, -value, event.blockNumber);
        await upsertBalance(client, event.tokenAddress, event.payload.to, value, event.blockNumber);
      }
      published.push(event);
    }
    await client.query(`
      DELETE FROM arc_holder_balances WHERE balance = 0
    `);
    await client.query(`
      INSERT INTO arc_indexer_state (stream, last_block, last_hash, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (stream) DO UPDATE
        SET last_block = EXCLUDED.last_block, last_hash = EXCLUDED.last_hash, updated_at = NOW()
    `, [STREAM, range.finalBlock.number.toString(), range.finalBlock.hash]);
    await client.query("COMMIT");
    return published;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function liveEvent(event) {
  const common = {
    id: event.id,
    blockNumber: event.blockNumber.toString(),
    blockHash: event.blockHash,
    transactionHash: event.transactionHash,
    logIndex: event.logIndex,
    timestamp: event.blockTimestamp,
    tokenAddress: event.tokenAddress,
    poolAddress: event.poolAddress,
  };
  if (event.eventName === "TokenLaunched") return { ...common, kind: "launch", ...event.payload };
  if (event.eventName === "Swap") return { ...common, kind: "swap", ...event.payload };
  if (event.eventName === "Transfer") return { ...common, kind: "holder_change", ...event.payload };
  if (event.eventName === "BuybackExecuted") return { ...common, kind: "buyback", ...event.payload };
  return null;
}

async function publishEvents(redis, events, status) {
  const batch = redis.multi();
  for (const stored of events) {
    const event = liveEvent(stored);
    if (!event) continue;
    const encoded = JSON.stringify(event);
    batch.lPush(RECENT_EVENTS_KEY, encoded);
    batch.lTrim(RECENT_EVENTS_KEY, 0, 199);
    batch.publish(EVENT_CHANNEL, encoded);
  }
  const encodedStatus = JSON.stringify(status);
  batch.set(STATUS_KEY, encodedStatus, { EX: 120 });
  batch.publish(STATUS_CHANNEL, encodedStatus);
  await batch.exec();
}

async function publishStatus(redis, status) {
  const encodedStatus = JSON.stringify(status);
  await redis.multi()
    .set(STATUS_KEY, encodedStatus, { EX: 120 })
    .publish(STATUS_CHANNEL, encodedStatus)
    .exec();
}

async function rebuildMaterializedState(client) {
  await client.query("DELETE FROM arc_holder_balances");
  await client.query("DELETE FROM arc_markets");
  await client.query(`
    INSERT INTO arc_markets (
      token_address, factory_address, pool_address, creator_address, name, symbol,
      position_id, automatic_buyback, launch_block, launch_timestamp, transaction_hash
    )
    SELECT
      token_address,
      contract_address,
      pool_address,
      payload->>'creator',
      payload->>'name',
      payload->>'symbol',
      position_id,
      COALESCE((payload->>'automaticBuyback')::boolean, false),
      block_number,
      block_timestamp,
      transaction_hash
    FROM arc_events
    WHERE event_name = 'TokenLaunched'
    ORDER BY block_number, log_index
    ON CONFLICT (token_address) DO NOTHING
  `);
  await client.query(`
    UPDATE arc_markets market
       SET automatic_buyback = config.enabled
      FROM (
        SELECT DISTINCT ON (token_address)
               token_address, (payload->>'enabled')::boolean AS enabled
          FROM arc_events
         WHERE event_name = 'AutomaticBuybackConfigured'
         ORDER BY token_address, block_number DESC, log_index DESC
      ) config
     WHERE market.token_address = config.token_address
  `);
  await client.query(`
    WITH deltas AS (
      SELECT token_address, payload->>'from' AS holder_address,
             -(payload->>'value')::numeric AS delta, block_number
        FROM arc_events
       WHERE event_name = 'Transfer' AND payload->>'from' <> $1
      UNION ALL
      SELECT token_address, payload->>'to' AS holder_address,
             (payload->>'value')::numeric AS delta, block_number
        FROM arc_events
       WHERE event_name = 'Transfer' AND payload->>'to' <> $1
    )
    INSERT INTO arc_holder_balances (token_address, holder_address, balance, updated_block)
    SELECT token_address, holder_address, SUM(delta), MAX(block_number)
      FROM deltas
     GROUP BY token_address, holder_address
    HAVING SUM(delta) <> 0
  `, [ZERO_ADDRESS]);
}

async function reconcileReorg(publicClient, database, fromBlock, maxDepth) {
  const state = await loadState(database, fromBlock);
  if (state.lastBlock < fromBlock || !state.lastHash) return state;
  const canonical = await withRetry(() => publicClient.getBlock({ blockNumber: state.lastBlock }), 3);
  if (normalizeHex(canonical.hash) === state.lastHash) return state;
  const candidates = await database.query(`
    SELECT block_number, block_hash
      FROM arc_blocks
     WHERE block_number <= $1
     ORDER BY block_number DESC
     LIMIT $2
  `, [state.lastBlock.toString(), maxDepth]);
  let commonBlock = fromBlock - 1n;
  let commonHash = null;
  for (const candidate of candidates.rows) {
    const blockNumber = BigInt(candidate.block_number);
    const block = await withRetry(() => publicClient.getBlock({ blockNumber }), 3);
    if (normalizeHex(block.hash) === candidate.block_hash) {
      commonBlock = blockNumber;
      commonHash = candidate.block_hash;
      break;
    }
  }
  const rollbackFrom = commonBlock + 1n;
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM arc_events WHERE block_number >= $1", [rollbackFrom.toString()]);
    await client.query("DELETE FROM arc_blocks WHERE block_number >= $1", [rollbackFrom.toString()]);
    await rebuildMaterializedState(client);
    await client.query(`
      INSERT INTO arc_indexer_state (stream, last_block, last_hash, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (stream) DO UPDATE
        SET last_block = EXCLUDED.last_block, last_hash = EXCLUDED.last_hash, updated_at = NOW()
    `, [STREAM, commonBlock.toString(), commonHash]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  console.warn(`[indexer] reorg rollback from block ${rollbackFrom}`);
  return { lastBlock: commonBlock, lastHash: commonHash };
}

async function main() {
  const databaseUrl = required("DATABASE_URL");
  const redisUrl = required("REDIS_URL");
  const factory = normalizeHex(required("NEXT_PUBLIC_MAINNET_FACTORY_ADDRESS"));
  const usdc = normalizeHex(process.env.NEXT_PUBLIC_MAINNET_USDC_ADDRESS?.trim()
    || "0x3600000000000000000000000000000000000000");
  const fromBlock = BigInt(required("NEXT_PUBLIC_MAINNET_FACTORY_FROM_BLOCK"));
  const confirmations = BigInt(positiveInteger("INDEXER_CONFIRMATIONS", 2));
  const batchSize = BigInt(positiveInteger("INDEXER_BATCH_SIZE", 5_000));
  const pollInterval = positiveInteger("INDEXER_POLL_INTERVAL_MS", 2_000);
  const addressChunkSize = positiveInteger("INDEXER_ADDRESS_CHUNK_SIZE", 20);
  const reorgDepth = positiveInteger("INDEXER_REORG_DEPTH", 64);
  const urls = rpcUrls();
  const publicClient = createArcClient(urls);
  const database = new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 20_000,
  });
  const redis = createRedisClient({ url: redisUrl, socket: { connectTimeout: 5_000 } });
  redis.on("error", (error) => console.error("[indexer] redis", error.message));
  await database.query("SELECT 1");
  await runMigration(database);
  await redis.connect();
  const locker = normalizeHex(await withRetry(() => publicClient.readContract({
    address: factory,
    abi: liquidityLockerAbi,
    functionName: "liquidityLocker",
  })));
  const config = { factory, usdc, locker, addressChunkSize };
  console.log(`[indexer] started factory=${factory} locker=${locker} rpc=${urls.length}`);

  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  while (!stopping) {
    try {
      let state = await reconcileReorg(publicClient, database, fromBlock, reorgDepth);
      const latestBlock = await withRetry(() => publicClient.getBlockNumber());
      const safeBlock = latestBlock > confirmations ? latestBlock - confirmations : 0n;
      if (state.lastBlock < safeBlock) {
        const nextBlock = state.lastBlock + 1n < fromBlock ? fromBlock : state.lastBlock + 1n;
        const toBlock = nextBlock + batchSize - 1n < safeBlock ? nextBlock + batchSize - 1n : safeBlock;
        const range = await readRange(publicClient, database, config, nextBlock, toBlock);
        const events = await storeRange(database, range, config);
        const status = {
          status: "ok",
          stream: STREAM,
          indexedBlock: toBlock.toString(),
          indexedBlockHash: range.finalBlock.hash,
          latestBlock: latestBlock.toString(),
          blockLag: (latestBlock - toBlock).toString(),
          eventsPublished: events.length,
          generatedAt: new Date().toISOString(),
        };
        await publishEvents(redis, events, status);
        if (events.length > 0 || toBlock === safeBlock) {
          console.log(`[indexer] blocks=${nextBlock}-${toBlock} events=${events.length} lag=${latestBlock - toBlock}`);
        }
        state = { lastBlock: toBlock, lastHash: range.finalBlock.hash };
      } else {
        await publishStatus(redis, {
          status: "ok",
          stream: STREAM,
          indexedBlock: state.lastBlock.toString(),
          indexedBlockHash: state.lastHash,
          latestBlock: latestBlock.toString(),
          blockLag: (latestBlock - state.lastBlock).toString(),
          eventsPublished: 0,
          generatedAt: new Date().toISOString(),
        });
        await wait(pollInterval);
      }
    } catch (error) {
      console.error("[indexer] cycle failed", error instanceof Error ? error.message : error);
      await publishStatus(redis, {
        status: "degraded",
        stream: STREAM,
        error: error instanceof Error ? error.message : "Indexer cycle failed",
        generatedAt: new Date().toISOString(),
      }).catch(() => undefined);
      await wait(Math.max(5_000, pollInterval));
    }
  }
  await Promise.allSettled([redis.quit(), database.end()]);
  console.log("[indexer] stopped");
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[indexer] fatal", error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  createArcClient,
  eventId,
  jsonSafe,
  priceFromSqrt,
  rpcUrls,
  swapPayload,
  tokenIsToken0,
  traderFromTransferFlow,
  transferFlowKey,
  withRetry,
};
