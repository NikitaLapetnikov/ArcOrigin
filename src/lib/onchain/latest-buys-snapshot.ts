import "server-only";

import { isAddress, isHash, type Address } from "viem";
import { ARCORIGIN_NETWORK, ARC_ACTIVE_FACTORY } from "@/lib/chains";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import {
  createCanonicalCheckpoint,
  getCanonicalCheckpointStatus,
} from "@/lib/onchain/canonical-checkpoint";
import { getMarketSnapshot } from "@/lib/onchain/market-snapshot";
import { getTokenIndexSnapshot } from "@/lib/onchain/token-index-snapshot";
import { readPersistentSnapshot, writePersistentSnapshot } from "@/lib/server/persistent-cache";
import type { LatestBuyRecord, LatestBuysSnapshot, Trade } from "@/lib/types";

const CACHE_TTL_MS = 15_000;
const REFRESH_COOLDOWN_MS = 5_000;
const MARKET_CONCURRENCY = 4;
const LATEST_BUY_LIMIT = 50;
const PERSISTENT_CACHE_KEY =
  `arcorigin:${ARCORIGIN_NETWORK}:latest-buys:${ARC_ACTIVE_FACTORY.toLowerCase()}`;

type LatestBuysState = {
  snapshot: LatestBuysSnapshot | null;
  cachedAt: number;
  lastAttemptAt: number;
  pending: Promise<LatestBuysSnapshot> | null;
};

declare global {
  var __arcOriginLatestBuysState: LatestBuysState | undefined;
}

const state = globalThis.__arcOriginLatestBuysState ?? {
  snapshot: null,
  cachedAt: 0,
  lastAttemptAt: 0,
  pending: null,
};
globalThis.__arcOriginLatestBuysState = state;

const publicClient = createArcPublicClient(
  process.env.ARC_MAINNET_RPC_URL,
  8_000,
);

function readCanonicalBlock(blockNumber: bigint) {
  return publicClient.getBlock({ blockNumber });
}

function isTrade(value: unknown): value is Trade {
  if (!value || typeof value !== "object") return false;
  const trade = value as Partial<Trade>;
  return (trade.type === "Buy" || trade.type === "Sell")
    && typeof trade.wallet === "string"
    && isAddress(trade.wallet)
    && typeof trade.usdc === "number"
    && Number.isFinite(trade.usdc)
    && trade.usdc >= 0
    && typeof trade.tokens === "number"
    && Number.isFinite(trade.tokens)
    && trade.tokens > 0
    && typeof trade.price === "number"
    && Number.isFinite(trade.price)
    && typeof trade.txHash === "string"
    && isHash(trade.txHash);
}

function isLatestBuysSnapshot(value: unknown): value is LatestBuysSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<LatestBuysSnapshot>;
  return Array.isArray(snapshot.buys)
    && snapshot.buys.length <= LATEST_BUY_LIMIT
    && snapshot.buys.every((record) => (
      record
      && typeof record === "object"
      && isAddress(record.tokenAddress)
      && isTrade(record.trade)
      && record.trade.type === "Buy"
    ))
    && Array.isArray(snapshot.tokenAddresses)
    && snapshot.tokenAddresses.every((address) => isAddress(address))
    && typeof snapshot.indexedBlock === "string"
    && /^\d+$/.test(snapshot.indexedBlock)
    && typeof snapshot.indexedBlockHash === "string"
    && isHash(snapshot.indexedBlockHash)
    && typeof snapshot.generatedAt === "string"
    && Number.isFinite(Date.parse(snapshot.generatedAt));
}

function sameTokenSet(snapshot: LatestBuysSnapshot, tokenAddresses: string[]) {
  if (snapshot.tokenAddresses.length !== tokenAddresses.length) return false;
  const expected = new Set(tokenAddresses.map((address) => address.toLowerCase()));
  return snapshot.tokenAddresses.every((address) => expected.has(address.toLowerCase()));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
) {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += concurrency) {
    results.push(...await Promise.all(items.slice(index, index + concurrency).map(worker)));
  }
  return results;
}

async function buildLatestBuysSnapshot(
  tokenIndex: Awaited<ReturnType<typeof getTokenIndexSnapshot>>["snapshot"],
  forceRefresh: boolean,
) {
  if (!tokenIndex) throw new Error("Factory token index is unavailable.");
  const marketSnapshots = await mapWithConcurrency(tokenIndex.tokens, MARKET_CONCURRENCY, async (token) => ({
    tokenAddress: token.address,
    market: (await getMarketSnapshot(token.address as Address, forceRefresh)).snapshot,
  }));
  const byHash = new Map<string, LatestBuyRecord>();
  for (const { tokenAddress, market } of marketSnapshots) {
    for (const trade of market.trades) {
      if (trade.type !== "Buy") continue;
      const key = trade.txHash.toLowerCase();
      if (!byHash.has(key)) byHash.set(key, { tokenAddress, trade });
    }
  }
  const checkpoint = tokenIndex.indexedBlockHash
    ? {
      indexedBlock: tokenIndex.indexedBlock,
      indexedBlockHash: tokenIndex.indexedBlockHash,
    }
    : await createCanonicalCheckpoint(BigInt(tokenIndex.indexedBlock), readCanonicalBlock);
  return {
    buys: [...byHash.values()]
      .sort((left, right) => (right.trade.timestamp ?? 0) - (left.trade.timestamp ?? 0))
      .slice(0, LATEST_BUY_LIMIT),
    tokenAddresses: tokenIndex.tokens.map((token) => token.address),
    ...checkpoint,
    generatedAt: new Date().toISOString(),
  } satisfies LatestBuysSnapshot;
}

export async function getLatestBuysSnapshot(forceRefresh = false) {
  const indexResult = await getTokenIndexSnapshot(forceRefresh);
  const tokenAddresses = indexResult.snapshot?.tokens.map((token) => token.address) ?? [];

  if (!state.snapshot) {
    const persisted = await readPersistentSnapshot<unknown>(PERSISTENT_CACHE_KEY);
    if (isLatestBuysSnapshot(persisted) && sameTokenSet(persisted, tokenAddresses)) {
      const checkpoint = await getCanonicalCheckpointStatus(persisted, readCanonicalBlock);
      if (checkpoint === "canonical" || checkpoint === "unavailable") {
        state.snapshot = persisted;
        state.cachedAt = Date.parse(persisted.generatedAt) || 0;
      }
    }
  }

  const now = Date.now();
  const cacheMatchesIndex = state.snapshot && sameTokenSet(state.snapshot, tokenAddresses);
  const isFresh = cacheMatchesIndex && now - state.cachedAt < CACHE_TTL_MS;
  const refreshThrottled = cacheMatchesIndex
    && now - state.lastAttemptAt < REFRESH_COOLDOWN_MS;
  if (isFresh && !forceRefresh) return { snapshot: state.snapshot, stale: false };
  if (refreshThrottled) {
    return { snapshot: state.snapshot, stale: now - state.cachedAt >= CACHE_TTL_MS };
  }

  if (!state.pending) {
    state.lastAttemptAt = now;
    state.pending = buildLatestBuysSnapshot(indexResult.snapshot, forceRefresh)
      .then((snapshot) => {
        state.snapshot = snapshot;
        state.cachedAt = Date.now();
        void writePersistentSnapshot(PERSISTENT_CACHE_KEY, snapshot);
        return snapshot;
      })
      .finally(() => {
        state.pending = null;
      });
  }

  if (cacheMatchesIndex && !forceRefresh) {
    void state.pending.catch(() => undefined);
    return { snapshot: state.snapshot, stale: true };
  }

  try {
    return { snapshot: await state.pending, stale: false };
  } catch (error) {
    if (cacheMatchesIndex && state.snapshot) return { snapshot: state.snapshot, stale: true };
    throw error;
  }
}
