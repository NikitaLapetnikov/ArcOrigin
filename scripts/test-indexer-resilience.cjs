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
