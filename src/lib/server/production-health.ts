import "server-only";

import { isAddress, type Address } from "viem";
import {
  ARC_ACTIVE_CONTRACTS,
  ARC_MULTICALL3_ADDRESS,
  ARCORIGIN_NETWORK,
  arcChain,
} from "@/lib/chains";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import { getTokenIndexCacheStatus } from "@/lib/onchain/token-index-snapshot";
import { isRetryableRpcError } from "@/lib/rpc-errors";
import { getPersistentCacheStatus } from "@/lib/server/persistent-cache";
import { getEventStoreStatus } from "@/lib/server/event-store";

const factoryHealthAbi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
] as const;

const healthClient = createArcPublicClient(
  process.env.ARC_MAINNET_RPC_URL,
  3_000,
  0,
);
const HEALTH_CACHE_TTL_MS = 30_000;
const DEFAULT_INDEXER_MAX_BLOCK_LAG = 300n;

function indexerMaxBlockLag() {
  const value = process.env.INDEXER_MAX_BLOCK_LAG?.trim();
  return value && /^\d+$/.test(value)
    ? BigInt(value)
    : DEFAULT_INDEXER_MAX_BLOCK_LAG;
}

function expectedOwner() {
  const value = process.env.MAINNET_GOVERNANCE_SAFE?.trim();
  return value && isAddress(value) ? value as Address : null;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settle<T>(operation: () => Promise<T>): Promise<PromiseSettledResult<T>> {
  try {
    return { status: "fulfilled", value: await operation() };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

async function settleRpc<T>(operation: () => Promise<T>, attempts = 3): Promise<PromiseSettledResult<T>> {
  return settle(async () => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryableRpcError(error) || attempt === attempts) throw error;
        await wait(attempt * 500);
      }
    }
    throw new Error("Arc health RPC failed after retries.");
  });
}

async function loadProductionHealth() {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  const expectedLaunchPaused = process.env.MAINNET_EXPECT_LAUNCHES_PAUSED !== "false";
  const owner = expectedOwner();
  const errors: string[] = [];
  const warnings: string[] = [];

  try {
    // Keep Redis independent, but serialize Arc reads so the health probe does
    // not create its own burst against capacity-constrained public RPCs.
    const cachePromise = settle(() => getPersistentCacheStatus());
    const eventStorePromise = settle(() => getEventStoreStatus());
    const [chainResult, blockResult] = await Promise.all([
      settleRpc(() => healthClient.getChainId()),
      settleRpc(() => healthClient.getBlockNumber()),
    ]);
    const [bytecodeResult, factoryStateResult] = await Promise.all([
      settleRpc(() => healthClient.getBytecode({ address: ARC_ACTIVE_CONTRACTS.factory })),
      settleRpc(() => healthClient.multicall({
        allowFailure: false,
        multicallAddress: ARC_MULTICALL3_ADDRESS,
        contracts: [
          {
            address: ARC_ACTIVE_CONTRACTS.factory,
            abi: factoryHealthAbi,
            functionName: "owner",
          },
          {
            address: ARC_ACTIVE_CONTRACTS.factory,
            abi: factoryHealthAbi,
            functionName: "paused",
          },
        ],
      })),
    ]);
    const indexerResult = await settleRpc(() => getTokenIndexCacheStatus());
    const [cacheResult, eventStoreResult] = await Promise.all([cachePromise, eventStorePromise]);

    const chainId = chainResult.status === "fulfilled" ? chainResult.value : null;
    const latestBlock = blockResult.status === "fulfilled" ? blockResult.value : null;
    const bytecode = bytecodeResult.status === "fulfilled" ? bytecodeResult.value : null;
    const factoryOwner = factoryStateResult.status === "fulfilled" ? factoryStateResult.value[0] : null;
    const launchesPaused = factoryStateResult.status === "fulfilled" ? factoryStateResult.value[1] : null;
    const legacyIndexer = indexerResult.status === "fulfilled" ? indexerResult.value : null;
    const cache = cacheResult.status === "fulfilled" ? cacheResult.value : null;
    const eventStore = eventStoreResult.status === "fulfilled" ? eventStoreResult.value : null;
    const indexer = eventStore?.reachable && eventStore.indexedBlock
      ? {
          available: true,
          indexedBlock: eventStore.indexedBlock,
          ageSeconds: eventStore.ageSeconds,
          checkpoint: "worker-verified" as const,
          tokenCount: legacyIndexer?.tokenCount ?? null,
        }
      : legacyIndexer;
    const ownerMatches = owner && factoryOwner
      ? factoryOwner.toLowerCase() === owner.toLowerCase()
      : null;
    const blockLag = indexer?.indexedBlock && latestBlock !== null
      ? latestBlock - BigInt(indexer.indexedBlock)
      : null;

    if (chainId === null) errors.push("rpc_chain_unavailable");
    else if (chainId !== arcChain.id) errors.push("rpc_chain_mismatch");
    if (latestBlock === null) errors.push("rpc_block_unavailable");
    if (bytecodeResult.status === "rejected") errors.push("factory_code_unavailable");
    else if (!bytecode || bytecode === "0x") errors.push("factory_code_missing");
    // Transient public-RPC eth_call capacity must not take the application out
    // of service when chain identity, bytecode and the dedicated event store
    // are healthy. A confirmed mismatch still fails closed below.
    if (!factoryOwner) warnings.push("factory_owner_unavailable");
    if (ownerMatches === false) errors.push("factory_owner_mismatch");
    if (launchesPaused === null) warnings.push("launch_pause_unavailable");
    else if (launchesPaused !== expectedLaunchPaused) errors.push("launch_pause_mismatch");
    if (indexer?.checkpoint === "orphaned" || indexer?.checkpoint === "invalid") {
      errors.push("indexer_checkpoint_noncanonical");
    }
    if (!indexer) warnings.push("indexer_status_unavailable");
    else if (!indexer.available) warnings.push("indexer_snapshot_missing");
    if (blockLag !== null && blockLag > indexerMaxBlockLag()) warnings.push("indexer_lagging");
    if (!cache) warnings.push("persistent_cache_status_unavailable");
    else if (!cache.configured) warnings.push("persistent_cache_not_configured");
    else if (!cache.reachable) warnings.push("persistent_cache_unreachable");
    if (!eventStore) warnings.push("event_store_status_unavailable");
    else if (!eventStore.configured) warnings.push("event_store_not_configured");
    else if (!eventStore.reachable) warnings.push("event_store_unreachable");
    else if (!eventStore.indexedBlock) warnings.push("event_store_not_indexed");
    if (!owner) warnings.push("expected_factory_owner_not_configured");

    return {
      status: errors.length > 0 ? "error" : warnings.length > 0 ? "degraded" : "ok",
      checkedAt,
      latencyMs: Date.now() - startedAt,
      network: ARCORIGIN_NETWORK,
      chainId: chainId ?? arcChain.id,
      latestBlock: latestBlock?.toString() ?? null,
      contracts: {
        factory: ARC_ACTIVE_CONTRACTS.factory,
        codePresent: Boolean(bytecode && bytecode !== "0x"),
        ownerMatches,
        launchesPaused,
      },
      indexer: indexer
        ? { ...indexer, blockLag: blockLag?.toString() ?? null }
        : null,
      cache,
      eventStore,
      errors,
      warnings,
    };
  } catch {
    return {
      status: "error" as const,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      network: ARCORIGIN_NETWORK,
      chainId: arcChain.id,
      latestBlock: null,
      contracts: null,
      indexer: null,
      cache: null,
      eventStore: null,
      errors: ["health_dependency_unavailable"],
      warnings,
    };
  }
}

type ProductionHealth = Awaited<ReturnType<typeof loadProductionHealth>>;

declare global {
  var __arcOriginProductionHealth:
    | {
        snapshot: ProductionHealth | null;
        cachedAt: number;
        pending: Promise<ProductionHealth> | null;
      }
    | undefined;
}

const healthState = globalThis.__arcOriginProductionHealth ?? {
  snapshot: null,
  cachedAt: 0,
  pending: null,
};
globalThis.__arcOriginProductionHealth = healthState;

export async function getProductionHealth() {
  if (
    healthState.snapshot
    && Date.now() - healthState.cachedAt < HEALTH_CACHE_TTL_MS
  ) return healthState.snapshot;
  if (!healthState.pending) {
    healthState.pending = loadProductionHealth()
      .then((snapshot) => {
        healthState.snapshot = snapshot;
        healthState.cachedAt = Date.now();
        return snapshot;
      })
      .finally(() => {
        healthState.pending = null;
      });
  }
  if (healthState.snapshot) {
    // Health probes must never amplify a degraded public RPC. Return the last
    // complete result immediately while a single background check refreshes it.
    return healthState.snapshot;
  }
  return healthState.pending;
}
