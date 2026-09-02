"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const moduleCache = new Map();

function loadTypeScriptModule(filePath) {
  const absolutePath = path.resolve(filePath);
  if (moduleCache.has(absolutePath)) return moduleCache.get(absolutePath).exports;
  const source = fs.readFileSync(absolutePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: absolutePath,
  }).outputText;
  const loaded = { exports: {} };
  moduleCache.set(absolutePath, loaded);
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    const candidate = path.resolve(path.dirname(absolutePath), specifier);
    const resolved = fs.existsSync(candidate) ? candidate : `${candidate}.ts`;
    return loadTypeScriptModule(resolved);
  };
  const execute = new Function("require", "module", "exports", "__filename", "__dirname", output);
  execute(localRequire, loaded, loaded.exports, absolutePath, path.dirname(absolutePath));
  return loaded.exports;
}

const { normalizeEvent } = loadTypeScriptModule("src/lib/indexer/normalize.ts");
const { reconcileIndexedEvents } = loadTypeScriptModule("src/lib/indexer/reconcile.ts");
const {
  createCanonicalCheckpoint,
  getCanonicalCheckpointStatus,
  upgradeLegacyCanonicalCheckpoint,
} = loadTypeScriptModule("src/lib/onchain/canonical-checkpoint.ts");
const {
  hasCompleteFactoryLaunchSet,
} = loadTypeScriptModule("src/lib/onchain/factory-index-validation.ts");
const {
  snapshotRevalidationDelay,
} = loadTypeScriptModule("src/lib/onchain/snapshot-revalidation.ts");
const {
  snapshotCacheControl,
} = loadTypeScriptModule("src/lib/onchain/snapshot-http-cache.ts");
const {
  DEFAULT_ANALYTICS_RANGE,
  isProtocolAnalyticsSnapshot,
} = loadTypeScriptModule("src/lib/analytics.ts");
const {
  isRetryableRpcError,
  isRpcCapacityError,
  isUnauthorizedBlockdaemonRpc,
  walletRpcPreflightDecision,
} = loadTypeScriptModule("src/lib/rpc-errors.ts");
const {
  nativeUsdcToPrecompileBalance,
  requiredNativeUsdcBalance,
} = loadTypeScriptModule("src/lib/arc-usdc.ts");
const {
  rpcRetryDelayMs,
  transientRpcFailure,
} = require("./run-buyback-keeper.cjs");
const {
  eventId: workerEventId,
  swapPayload,
  tokenIsToken0,
  traderFromTransferFlow,
} = require("./run-event-indexer.cjs");
const {
  isLiveIndexerEvent,
  replayPayloadsAfter,
  tradeDetailFromIndexerEvent,
} = loadTypeScriptModule("src/lib/indexer/live-event.ts");

const address = "0x1111111111111111111111111111111111111111";

function event(blockNumber, blockHashDigit, logIndex = 0) {
  const transactionDigit = (Number(blockNumber) % 10).toString(16);
  return {
    name: "TokenBought",
    address,
    blockNumber: BigInt(blockNumber),
    blockHash: `0x${blockHashDigit.repeat(64)}`,
    transactionHash: `0x${transactionDigit.repeat(64)}`,
    logIndex,
    args: {},
  };
}

test("duplicate logs remain idempotent", () => {
  const first = event(10, "a");
  const result = reconcileIndexedEvents([first], [first, first]);
  assert.equal(result.events.length, 1);
  assert.equal(result.duplicateCount, 2);
  assert.equal(result.rollbackFromBlock, null);
});

test("same transaction and event name retain distinct log indexes", () => {
  const left = event(10, "a", 1);
  const right = event(10, "a", 2);
  const result = reconcileIndexedEvents([], [right, left]);
  assert.equal(result.events.length, 2);
  assert.notEqual(normalizeEvent(left).id, normalizeEvent(right).id);
  assert.deepEqual(result.events.map((item) => item.logIndex), [1, 2]);
});

test("backfill batches merge in canonical order", () => {
  const result = reconcileIndexedEvents(
    [event(12, "c")],
    [event(11, "b"), event(10, "a")],
  );
  assert.deepEqual(result.events.map((item) => item.blockNumber), [10n, 11n, 12n]);
});

test("reorg rolls back the fork block and every later event", () => {
  const oldTen = event(10, "a");
  const oldEleven = event(11, "b");
  const newTen = event(10, "d");
  const result = reconcileIndexedEvents([oldTen, oldEleven], [newTen]);
  assert.equal(result.rollbackFromBlock, 10n);
  assert.deepEqual(result.events, [newTen]);
});

test("normalized event identity survives restart serialization", () => {
  const normalized = normalizeEvent(event(10, "a", 7));
  const restored = JSON.parse(JSON.stringify(normalized));
  assert.equal(restored.id, normalized.id);
  assert.equal(restored.blockNumber, "10");
});

test("checkpoint distinguishes canonical, orphaned, invalid and unavailable states", async () => {
  const canonicalHash = `0x${"a".repeat(64)}`;
  const checkpoint = await createCanonicalCheckpoint(42n, async () => ({ hash: canonicalHash }));
  assert.equal(
    await getCanonicalCheckpointStatus(checkpoint, async () => ({ hash: canonicalHash })),
    "canonical",
  );
  assert.equal(
    await getCanonicalCheckpointStatus(checkpoint, async () => ({ hash: `0x${"b".repeat(64)}` })),
    "orphaned",
  );
  assert.equal(
    await getCanonicalCheckpointStatus({ indexedBlock: "42" }, async () => ({ hash: canonicalHash })),
    "invalid",
  );
  assert.equal(
    await getCanonicalCheckpointStatus(checkpoint, async () => {
      throw new Error("RPC unavailable");
    }),
    "unavailable",
  );
});

test("legacy snapshots gain a canonical hash without a full index rebuild", async () => {
  const canonicalHash = `0x${"c".repeat(64)}`;
  const snapshot = { indexedBlock: "42", generatedAt: "2026-07-30T00:00:00.000Z" };
  const upgraded = await upgradeLegacyCanonicalCheckpoint(
    snapshot,
    async (blockNumber) => {
      assert.equal(blockNumber, 42n);
      return { hash: canonicalHash };
    },
  );
  assert.deepEqual(upgraded, { ...snapshot, indexedBlockHash: canonicalHash });
  assert.equal(
    await upgradeLegacyCanonicalCheckpoint(
      { ...snapshot, indexedBlockHash: canonicalHash },
      async () => ({ hash: canonicalHash }),
    ),
    null,
  );
});

test("explorer launch sets are accepted only when they match the Factory count", () => {
  assert.equal(hasCompleteFactoryLaunchSet(3, 3n), true);
  assert.equal(hasCompleteFactoryLaunchSet(2, 3n), false);
  assert.equal(hasCompleteFactoryLaunchSet(0, 1n), false);
  assert.equal(hasCompleteFactoryLaunchSet(0, 0n), true);
  assert.equal(hasCompleteFactoryLaunchSet(-1, 0n), false);
  assert.equal(
    hasCompleteFactoryLaunchSet(1, BigInt(Number.MAX_SAFE_INTEGER) + 1n),
    false,
  );
});

test("stale snapshots revalidate quickly and settle on a bounded retry interval", () => {
  assert.equal(snapshotRevalidationDelay(-1), 1_500);
  assert.equal(snapshotRevalidationDelay(0), 1_500);
  assert.equal(snapshotRevalidationDelay(1), 3_000);
  assert.equal(snapshotRevalidationDelay(4), 30_000);
  assert.equal(snapshotRevalidationDelay(100), 30_000);
});

test("stale and forced snapshots cannot be retained by an HTTP cache", () => {
  const freshPolicy = "public, max-age=15";
  assert.equal(snapshotCacheControl({ forceRefresh: false, stale: false, freshPolicy }), freshPolicy);
  assert.equal(snapshotCacheControl({ forceRefresh: false, stale: true, freshPolicy }), "no-store");
  assert.equal(snapshotCacheControl({ forceRefresh: true, stale: false, freshPolicy }), "no-store");
});

test("protocol analytics opens on the lifetime view", () => {
  assert.equal(DEFAULT_ANALYTICS_RANGE, "all");
});

test("protocol analytics cache accepts only complete versioned snapshots", () => {
  const snapshot = {
    schemaVersion: 1,
    range: "24h",
    metrics: { volumeUsdc: 10, trades: 2, traders: 1, launches: 1, creators: 1, automaticBuybackLaunches: 1 },
    allTime: { volumeUsdc: 20, trades: 4, traders: 2, launches: 1, creators: 1, automaticBuybackLaunches: 1, holders: 2 },
    economics: {
      feeEquivalentUsdc: .1,
      creatorEarningsEquivalentUsdc: 0,
      protocolRevenueEquivalentUsdc: .03,
      buybackAllocationEquivalentUsdc: .07,
      buybackSpentUsdc: .05,
      tokensBurned: 100,
      buybackExecutions: 1,
    },
    launchModes: { standard: 0, automaticBuyback: 1 },
    series: [{ timestamp: 1, volumeUsdc: 10, trades: 2, launches: 1, buybackSpentUsdc: .05 }],
    markets: [{
      address,
      name: "Origin",
      symbol: "ORIGIN",
      automaticBuyback: true,
      volumeUsdc: 10,
      trades: 2,
      traders: 1,
    }],
    indexedBlock: "42",
    indexedBlockHash: `0x${"a".repeat(64)}`,
    generatedAt: "2026-09-01T00:00:00.000Z",
  };
  assert.equal(isProtocolAnalyticsSnapshot(snapshot), true);
  assert.equal(isProtocolAnalyticsSnapshot({ ...snapshot, schemaVersion: 2 }), false);
  assert.equal(isProtocolAnalyticsSnapshot({ ...snapshot, metrics: { ...snapshot.metrics, volumeUsdc: -1 } }), false);
});

test("Postgres migrations remain ordered and idempotent", () => {
  const migrations = fs.readdirSync(path.resolve("deploy/postgres"))
    .filter((fileName) => /^\d+_[a-z0-9_]+\.sql$/.test(fileName))
    .sort();
  assert.deepEqual(migrations, ["001_event_store.sql", "002_protocol_analytics_indexes.sql"]);
  for (const migration of migrations) {
    const sql = fs.readFileSync(path.resolve("deploy/postgres", migration), "utf8");
    assert.match(sql, /CREATE (TABLE|INDEX) IF NOT EXISTS/);
  }
});

test("Arc capacity errors remain retryable through nested RPC causes", () => {
  const error = {
    message: "Contract call failed",
    cause: {
      code: -32005,
      details: "Request exceeds defined limit.",
    },
  };
  assert.equal(isRpcCapacityError(error), true);
  assert.equal(isRetryableRpcError(error), true);
  assert.equal(isRetryableRpcError(new Error("execution reverted")), false);
});

test("retired wallet RPC authorization failures are detected before a transaction", () => {
  const error = {
    shortMessage: "HTTP request failed.",
    cause: {
      details: "Status: 401 Authorization Required",
      message: "URL: https://rpc.blockdaemon.mainnet.arc.io/",
    },
  };
  assert.equal(isUnauthorizedBlockdaemonRpc(error), true);
  assert.equal(isUnauthorizedBlockdaemonRpc(new Error("execution reverted")), false);
  assert.equal(walletRpcPreflightDecision(error), "repair");
});

test("wallet RPC capacity limits do not block a prepared transaction", () => {
  const capacityError = {
    shortMessage: "HTTP request failed.",
    cause: {
      details: "Request exceeds defined limit.",
      message: "URL: https://rpc.arc-scan.org/",
    },
  };
  assert.equal(walletRpcPreflightDecision(capacityError), "continue");
  assert.equal(walletRpcPreflightDecision(new Error("execution reverted")), "fail");
});

test("native USDC preflight reserves the six-decimal amount plus gas", () => {
  assert.equal(nativeUsdcToPrecompileBalance(141_500_000_999_999_999_999n), 141_500_000n);
  assert.equal(
    requiredNativeUsdcBalance(100_000n, 2_000_000_000n, 1_500_000n),
    1_500_200_000_000_000_000n,
  );
});

test("keeper recognizes Arc provider capacity failures before retrying", () => {
  assert.equal(transientRpcFailure({ code: -32005, details: "Request exceeds defined limit." }), true);
  assert.equal(transientRpcFailure({ details: "all upstream temporarily out of capacity" }), true);
  assert.equal(transientRpcFailure(new Error("execution reverted")), false);
  assert.equal(rpcRetryDelayMs({ details: 'retry_after_seconds":11' }, 1), 11_000);
  assert.equal(rpcRetryDelayMs({ details: "temporarily out of capacity" }, 1), 15_000);
});

test("dedicated indexer derives a stable log identity and Arc swap direction", () => {
  const transactionHash = `0x${"a".repeat(64)}`;
  assert.equal(workerEventId({ transactionHash, logIndex: 7 }), `${transactionHash}:7`);
  const token = "0xce9c0e29f8d5904bfac3c8a79a0c9af00e6bdccb";
  const usdc = "0x3600000000000000000000000000000000000000";
  assert.equal(tokenIsToken0(token, usdc), false);
  const payload = swapPayload({
    sender: address,
    recipient: "0x2222222222222222222222222222222222222222",
    amount0: 100_000_000n,
    amount1: -20_000_000_000_000_000_000n,
    sqrtPriceX96: 1n << 96n,
    liquidity: 123_456n,
    tick: 0,
  }, { tokenAddress: token }, usdc);
  assert.equal(payload.side, "Buy");
  assert.equal(payload.usdc, 100);
  assert.equal(payload.tokens, 20);
  assert.equal(payload.liquidity, "123456");
  assert.equal(payload.wallet, "0x2222222222222222222222222222222222222222");
});

test("trader attribution follows net token flow through settlement contracts", () => {
  const pool = "0x9999999999999999999999999999999999999999";
  const trader = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const settlement = "0x7777777777777777777777777777777777777777";
  assert.equal(traderFromTransferFlow("Sell", pool, [
    { from: trader, to: settlement, value: "900" },
    { from: settlement, to: pool, value: "900" },
  ]), trader);
  assert.equal(traderFromTransferFlow("Buy", pool, [
    { from: pool, to: settlement, value: "700" },
    { from: settlement, to: trader, value: "700" },
  ]), trader);
});

test("trader attribution supports direct swaps and rejects incomplete flows", () => {
  const pool = "0x9999999999999999999999999999999999999999";
  const trader = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(traderFromTransferFlow("Sell", pool, [
    { from: trader, to: pool, value: "500" },
  ]), trader);
  assert.equal(traderFromTransferFlow("Buy", pool, [
    { from: pool, to: trader, value: "500" },
  ]), trader);
  assert.equal(traderFromTransferFlow("Sell", pool, []), null);
});

test("SSE events are validated before they update client state", () => {
  const liveEvent = {
    id: `${"0x" + "a".repeat(64)}:1`,
    kind: "swap",
    blockNumber: "42",
    blockHash: `0x${"b".repeat(64)}`,
    transactionHash: `0x${"a".repeat(64)}`,
    logIndex: 1,
    timestamp: 1_788_000_000,
    tokenAddress: address,
    poolAddress: "0x2222222222222222222222222222222222222222",
    side: "Buy",
    wallet: "0x3333333333333333333333333333333333333333",
    usdc: 12.5,
    tokens: 25,
    executionPrice: 0.51,
  };
  assert.equal(isLiveIndexerEvent(liveEvent), true);
  assert.deepEqual(tradeDetailFromIndexerEvent(liveEvent), {
    tokenAddress: address,
    transactionHash: liveEvent.transactionHash,
    side: "Buy",
    wallet: liveEvent.wallet,
    blockNumber: "42",
    timestamp: liveEvent.timestamp,
    usdc: 12.5,
    fee: 0,
    tokens: 25,
    executionPrice: 0.51,
  });
  assert.equal(isLiveIndexerEvent({ ...liveEvent, transactionHash: "bad" }), false);
});

test("SSE replay sends recent launches to fresh clients and missed events after a cursor", () => {
  const payload = (id) => JSON.stringify({ id });
  const recent = [payload("event-4"), payload("event-3"), payload("event-2"), payload("event-1")];
  assert.deepEqual(replayPayloadsAfter(recent, null), []);
  const now = Math.floor(Date.now() / 1_000);
  const recentLaunch = JSON.stringify({ id: "launch-new", kind: "launch", timestamp: now });
  const duplicateLaunch = JSON.stringify({ id: "launch-new", kind: "launch", timestamp: now, enriched: true });
  const oldLaunch = JSON.stringify({ id: "launch-old", kind: "launch", timestamp: now - 301 });
  assert.deepEqual(
    replayPayloadsAfter([recentLaunch, duplicateLaunch, oldLaunch], null).map((item) => JSON.parse(item).id),
    ["launch-new"],
  );
  assert.deepEqual(replayPayloadsAfter(recent, "unknown"), []);
  assert.deepEqual(
    replayPayloadsAfter(recent, "event-2").map((item) => JSON.parse(item).id),
    ["event-3", "event-4"],
  );
  assert.deepEqual(replayPayloadsAfter(recent, "event-4"), []);
});
