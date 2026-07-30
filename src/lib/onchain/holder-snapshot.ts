import "server-only";

import { decodeEventLog, formatUnits, parseAbiItem, toEventSelector, type Address, type Hash } from "viem";
import {
  ARCORIGIN_NETWORK,
  ARCORIGIN_PROTOCOL_VERSION,
  ARC_ACTIVE_FACTORY,
  ARC_ACTIVE_FACTORY_INDEXES,
} from "@/lib/chains";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import { getArcscanLogs } from "@/lib/onchain/arcscan-logs";
import {
  createCanonicalCheckpoint,
  getCanonicalCheckpointStatus,
} from "@/lib/onchain/canonical-checkpoint";
import { readPersistentSnapshot, writePersistentSnapshot } from "@/lib/server/persistent-cache";

const tokenLaunchedEvent = parseAbiItem("event TokenLaunched(address indexed token, address indexed curve, address indexed creator, string name, string symbol)");
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const PERMANENT_LIQUIDITY_LOCK = "0x000000000000000000000000000000000000dead";
const LOG_BLOCK_RANGE = 9_999n;
const FACTORY_CACHE_TTL_MS = 60_000;
const HOLDER_CACHE_TTL_MS = 45_000;
const MIN_REFRESH_INTERVAL_MS = 10_000;
const FORCE_REFRESH_INTERVAL_MS = 1_500;
const MAX_TOKEN_CACHES = 50;
const RPC_REQUEST_GAP_MS = 220;
const ACTIVE_FACTORY_INDEXES = ARC_ACTIVE_FACTORY_INDEXES.filter(
  (factory) => factory.address.toLowerCase() === ARC_ACTIVE_FACTORY.toLowerCase(),
);

export type FactoryLaunch = {
  factory: Address;
  token: Address;
  curve: Address;
  creator: Address;
  name: string;
  symbol: string;
  launchBlock: bigint;
  launchedAt: number;
  transactionHash: Hash;
};

export type HolderSnapshot = {
  holders: number;
  topHolders: HolderEntry[];
  creatorPercent: number;
  curvePercent: number;
  permanentLiquidityLockPercent: number;
  topTenExcludingCurvePercent: number;
  indexedBlock: string;
  indexedBlockHash?: Hash;
  generatedAt: string;
};

export type HolderEntry = {
  address: Address;
  balance: string;
  percent: number;
  role: "Creator" | "Curve" | "Holder";
};

export type HolderLaunchHint = {
  factory: Address;
  curve: Address;
  creator: Address;
  launchBlock: bigint;
};

type HolderCacheEntry = {
  snapshot: HolderSnapshot | null;
  cachedAt: number;
  lastAttemptAt: number;
  canonicalCheckedAt: number;
  pending: Promise<HolderSnapshot> | null;
};

type HolderState = {
  factoryLaunches: Map<string, FactoryLaunch>;
  factoryBlockTimestamps: Map<string, number>;
  factoryCachedAt: number;
  factoryIndexedBlock: bigint;
  factoryPending: Promise<Map<string, FactoryLaunch>> | null;
  tokenCaches: Map<string, HolderCacheEntry>;
};

const publicClient = createArcPublicClient(
  ARCORIGIN_NETWORK === "mainnet"
    ? process.env.ARC_MAINNET_RPC_URL
    : process.env.ARC_TESTNET_RPC_URL,
);

function readCanonicalBlock(blockNumber: bigint) {
  return publicClient.getBlock({ blockNumber });
}

declare global {
  var __arcOriginHolderState: HolderState | undefined;
}

const state = globalThis.__arcOriginHolderState ?? {
  factoryLaunches: new Map(),
  factoryBlockTimestamps: new Map(),
  factoryCachedAt: 0,
  factoryIndexedBlock: 0n,
  factoryPending: null,
  tokenCaches: new Map(),
};
state.factoryBlockTimestamps ??= new Map();
state.factoryIndexedBlock ??= 0n;
globalThis.__arcOriginHolderState = state;

export class FactoryTokenNotFoundError extends Error {}

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

function loadLaunchLogs(address: Address, fromBlock: bigint, toBlock: bigint) {
  return withRpcRetry(() => publicClient.getLogs({
    address,
    event: tokenLaunchedEvent,
    fromBlock,
    toBlock,
  }));
}

async function loadFactoryLaunches(indexedBlock: bigint, forceRefresh: boolean) {
  if (!forceRefresh) {
    try {
      const logGroups = await Promise.all(ACTIVE_FACTORY_INDEXES.map((factory) => getArcscanLogs({
        address: factory.address,
        fromBlock: factory.fromBlock,
        toBlock: indexedBlock,
        topic0: toEventSelector(tokenLaunchedEvent),
      })));
      const launches = new Map<string, FactoryLaunch>();
      for (const [factoryIndex, logs] of logGroups.entries()) {
        for (const log of logs) {
          const decoded = decodeEventLog({
            abi: [tokenLaunchedEvent],
            data: log.data,
            topics: log.topics,
          });
          const token = decoded.args.token;
          launches.set(token.toLowerCase(), {
            factory: ACTIVE_FACTORY_INDEXES[factoryIndex].address,
            token,
            curve: decoded.args.curve,
            creator: decoded.args.creator,
            name: decoded.args.name,
            symbol: decoded.args.symbol,
            launchBlock: log.blockNumber,
            launchedAt: log.timestamp,
            transactionHash: log.transactionHash,
          });
          state.factoryBlockTimestamps.set(log.blockNumber.toString(), log.timestamp);
        }
      }
      return launches;
    } catch {
      // The public explorer is an optimization only; verified RPC logs remain the fallback.
    }
  }

  const launches = new Map<string, FactoryLaunch>();
  for (const factory of ACTIVE_FACTORY_INDEXES) {
    for (let fromBlock = factory.fromBlock; fromBlock <= indexedBlock; fromBlock += LOG_BLOCK_RANGE + 1n) {
      const toBlock = fromBlock + LOG_BLOCK_RANGE < indexedBlock ? fromBlock + LOG_BLOCK_RANGE : indexedBlock;
      const logs = await loadLaunchLogs(factory.address, fromBlock, toBlock);
      for (const log of logs) {
        const token = log.args.token as Address;
        launches.set(token.toLowerCase(), {
          factory: factory.address,
          token,
          curve: log.args.curve as Address,
          creator: log.args.creator as Address,
          name: log.args.name ?? "Indexed token",
          symbol: log.args.symbol ?? "TOKEN",
          launchBlock: log.blockNumber ?? 0n,
          launchedAt: 0,
          transactionHash: log.transactionHash as Hash,
        });
      }
      await wait(RPC_REQUEST_GAP_MS);
    }
  }
  await Promise.all([...launches.values()].map(async (launch) => {
    const blockKey = launch.launchBlock.toString();
    let launchedAt = state.factoryBlockTimestamps.get(blockKey);
    if (launchedAt === undefined) {
      const block = await withRpcRetry(() => publicClient.getBlock({ blockNumber: launch.launchBlock }));
      launchedAt = Number(block.timestamp);
      state.factoryBlockTimestamps.set(blockKey, launchedAt);
    }
    launch.launchedAt = launchedAt;
  }));
  return launches;
}

async function getFactoryLaunches(indexedBlock: bigint, forceRefresh: boolean) {
  const cachedLaunchesHaveTimestamps = [...state.factoryLaunches.values()].every((launch) => Number.isInteger(launch.launchedAt) && launch.launchedAt > 0);
  if (!forceRefresh && state.factoryLaunches.size > 0 && cachedLaunchesHaveTimestamps && Date.now() - state.factoryCachedAt < FACTORY_CACHE_TTL_MS) {
    return state.factoryLaunches;
  }
  if (!state.factoryPending) {
    state.factoryPending = loadFactoryLaunches(indexedBlock, forceRefresh)
      .then((launches) => {
        if (launches.size === 0 && state.factoryLaunches.size > 0) {
          throw new Error("Factory launch source returned an unexpected empty snapshot.");
        }
        state.factoryLaunches = launches;
        state.factoryCachedAt = Date.now();
        return launches;
      })
      .finally(() => {
        state.factoryPending = null;
      });
  }
  return state.factoryPending;
}

export async function getVerifiedFactoryLaunch(tokenAddress: Address, forceRefresh = false) {
  const factoryCacheIsFresh = !forceRefresh
    && state.factoryIndexedBlock > 0n
    && Date.now() - state.factoryCachedAt < FACTORY_CACHE_TTL_MS;
  const indexedBlock = factoryCacheIsFresh
    ? state.factoryIndexedBlock
    : await withRpcRetry(() => publicClient.getBlockNumber());
  let launches = await getFactoryLaunches(indexedBlock, forceRefresh);
  let launch = launches.get(tokenAddress.toLowerCase());
  if (!launch && !forceRefresh) {
    launches = await getFactoryLaunches(indexedBlock, true);
    launch = launches.get(tokenAddress.toLowerCase());
  }
  if (!launch) throw new FactoryTokenNotFoundError("Token was not launched by the configured ArcOrigin factory.");
  return { launch, indexedBlock };
}

export async function getFactoryLaunchIndex(forceRefresh = false) {
  const indexedBlock = await withRpcRetry(() => publicClient.getBlockNumber());
  const launches = await getFactoryLaunches(indexedBlock, forceRefresh);
  state.factoryIndexedBlock = indexedBlock;
  return { launches: [...launches.values()], indexedBlock };
}

async function verifyLaunchHint(tokenAddress: Address, hint: HolderLaunchHint) {
  const knownFactory = ACTIVE_FACTORY_INDEXES.some(
    (factory) => factory.address.toLowerCase() === hint.factory.toLowerCase() && hint.launchBlock >= factory.fromBlock,
  );
  if (!knownFactory) throw new FactoryTokenNotFoundError("The supplied launch factory is not configured.");

  let logs;
  try {
    logs = await getArcscanLogs({
      address: hint.factory,
      fromBlock: hint.launchBlock,
      toBlock: hint.launchBlock,
      topic0: toEventSelector(tokenLaunchedEvent),
    });
  } catch {
    logs = await loadLaunchLogs(hint.factory, hint.launchBlock, hint.launchBlock);
  }
  if (logs.length === 0) {
    logs = await loadLaunchLogs(hint.factory, hint.launchBlock, hint.launchBlock);
  }
  for (const log of logs) {
    const decoded = "args" in log
      ? {
          token: log.args.token as Address,
          curve: log.args.curve as Address,
          creator: log.args.creator as Address,
          name: log.args.name ?? "Factory token",
          symbol: log.args.symbol ?? "TOKEN",
        }
      : decodeEventLog({ abi: [tokenLaunchedEvent], data: log.data, topics: log.topics }).args;
    if (decoded.token.toLowerCase() !== tokenAddress.toLowerCase()
      || decoded.curve.toLowerCase() !== hint.curve.toLowerCase()
      || decoded.creator.toLowerCase() !== hint.creator.toLowerCase()) continue;
    const launchedAt = "timestamp" in log
      ? log.timestamp
      : Number((await publicClient.getBlock({ blockNumber: hint.launchBlock })).timestamp);
    return {
      launch: {
        factory: hint.factory,
        token: decoded.token,
        curve: decoded.curve,
        creator: decoded.creator,
        name: decoded.name,
        symbol: decoded.symbol,
        launchBlock: hint.launchBlock,
        launchedAt,
        transactionHash: log.transactionHash as Hash,
      } satisfies FactoryLaunch,
      indexedBlock: await withRpcRetry(() => publicClient.getBlockNumber(), 2),
    };
  }
  throw new FactoryTokenNotFoundError("The supplied token was not emitted by the configured Factory at its launch block.");
}

function percentOf(part: bigint, total: bigint) {
  if (total === 0n) return 0;
  return Number(part * 1_000_000n / total) / 10_000;
}

async function loadHolderSnapshot(tokenAddress: Address, hint?: HolderLaunchHint): Promise<HolderSnapshot> {
  const { launch, indexedBlock } = hint
    ? await verifyLaunchHint(tokenAddress, hint)
    : await getVerifiedFactoryLaunch(tokenAddress);

  let explorerLogs;
  try {
    explorerLogs = await getArcscanLogs({
      address: launch.token,
      fromBlock: launch.launchBlock,
      toBlock: indexedBlock,
      topic0: toEventSelector(transferEvent),
    });
  } catch {
    explorerLogs = null;
  }

  const balances = new Map<string, bigint>();
  const seenTransfers = new Set<string>();
  const applyTransfer = (
    transactionHash: Hash,
    logIndex: number,
    from: string,
    to: string,
    value: bigint,
  ) => {
    const identity = `${transactionHash.toLowerCase()}:${logIndex}`;
    if (seenTransfers.has(identity)) return;
    seenTransfers.add(identity);
    if (from !== ZERO_ADDRESS) balances.set(from, (balances.get(from) ?? 0n) - value);
    if (to !== ZERO_ADDRESS) balances.set(to, (balances.get(to) ?? 0n) + value);
  };
  if (explorerLogs && explorerLogs.length > 0) {
    for (const log of explorerLogs) {
      const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
      const from = decoded.args.from.toLowerCase();
      const to = decoded.args.to.toLowerCase();
      applyTransfer(log.transactionHash, log.logIndex, from, to, decoded.args.value);
    }
  } else {
    const logRanges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
    for (let fromBlock = launch.launchBlock; fromBlock <= indexedBlock; fromBlock += LOG_BLOCK_RANGE + 1n) {
      const toBlock = fromBlock + LOG_BLOCK_RANGE < indexedBlock ? fromBlock + LOG_BLOCK_RANGE : indexedBlock;
      logRanges.push({ fromBlock, toBlock });
    }
    for (const { fromBlock, toBlock } of logRanges) {
      const logs = await withRpcRetry(() => publicClient.getLogs({
        address: launch.token,
        event: transferEvent,
        fromBlock,
        toBlock,
      }));
      for (const log of logs) {
        const from = (log.args.from ?? ZERO_ADDRESS).toLowerCase();
        const to = (log.args.to ?? ZERO_ADDRESS).toLowerCase();
        applyTransfer(
          log.transactionHash as Hash,
          log.logIndex ?? 0,
          from,
          to,
          log.args.value ?? 0n,
        );
      }
      await wait(RPC_REQUEST_GAP_MS);
    }
  }

  const positiveBalances = [...balances.entries()].filter(([, balance]) => balance > 0n);
  const totalSupply = positiveBalances.reduce((sum, [, balance]) => sum + balance, 0n);
  const curveAddress = launch.curve.toLowerCase();
  const creatorBalance = balances.get(launch.creator.toLowerCase()) ?? 0n;
  const curveBalance = balances.get(curveAddress) ?? 0n;
  const permanentLiquidityLockBalance = balances.get(PERMANENT_LIQUIDITY_LOCK) ?? 0n;
  const visibleHolders = positiveBalances.filter(([address]) => address !== PERMANENT_LIQUIDITY_LOCK);
  const topTenExcludingCurve = positiveBalances
    .filter(([address]) => address !== curveAddress && address !== PERMANENT_LIQUIDITY_LOCK)
    .map(([, balance]) => balance)
    .sort((left, right) => left === right ? 0 : left > right ? -1 : 1)
    .slice(0, 10)
    .reduce((sum, balance) => sum + balance, 0n);
  const topHolders: HolderEntry[] = visibleHolders
    .slice()
    .sort((left, right) => left[1] === right[1] ? 0 : left[1] > right[1] ? -1 : 1)
    .slice(0, 100)
    .map(([address, balance]) => ({
      address: address as Address,
      balance: formatUnits(balance, 18),
      percent: percentOf(balance, totalSupply),
      role: address === curveAddress
        ? "Curve"
        : address === launch.creator.toLowerCase()
          ? "Creator"
          : "Holder",
    }));

  const checkpoint = await createCanonicalCheckpoint(indexedBlock, readCanonicalBlock);
  return {
    holders: visibleHolders.length,
    topHolders,
    creatorPercent: percentOf(creatorBalance, totalSupply),
    curvePercent: percentOf(curveBalance, totalSupply),
    permanentLiquidityLockPercent: percentOf(permanentLiquidityLockBalance, totalSupply),
    topTenExcludingCurvePercent: percentOf(topTenExcludingCurve, totalSupply),
    ...checkpoint,
    generatedAt: new Date().toISOString(),
  };
}

function getTokenCache(tokenAddress: Address) {
  const key = `${ARCORIGIN_NETWORK}:${tokenAddress.toLowerCase()}`;
  const existing = state.tokenCaches.get(key);
  if (existing) {
    existing.canonicalCheckedAt ??= 0;
    return existing;
  }
  if (state.tokenCaches.size >= MAX_TOKEN_CACHES) {
    const oldestKey = state.tokenCaches.keys().next().value as string | undefined;
    if (oldestKey) state.tokenCaches.delete(oldestKey);
  }
  const entry: HolderCacheEntry = {
    snapshot: null,
    cachedAt: 0,
    lastAttemptAt: 0,
    canonicalCheckedAt: 0,
    pending: null,
  };
  state.tokenCaches.set(key, entry);
  return entry;
}

export async function getHolderSnapshot(tokenAddress: Address, forceRefresh = false, hint?: HolderLaunchHint) {
  const cache = getTokenCache(tokenAddress);
  const persistentKey =
    `arcorigin:${ARCORIGIN_NETWORK}:v${ARCORIGIN_PROTOCOL_VERSION}:holders:${tokenAddress.toLowerCase()}`;
  if (!cache.snapshot) {
    const persisted = await readPersistentSnapshot<HolderSnapshot>(persistentKey);
    const checkpointStatus = persisted
      ? await getCanonicalCheckpointStatus(persisted, readCanonicalBlock)
      : "invalid";
    if (
      persisted?.indexedBlock
      && Array.isArray(persisted.topHolders)
      && (checkpointStatus === "canonical" || checkpointStatus === "unavailable")
    ) {
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
  const isFresh = cache.snapshot && now - cache.cachedAt < HOLDER_CACHE_TTL_MS;
  const refreshThrottled = cache.snapshot
    && now - cache.lastAttemptAt < (forceRefresh ? FORCE_REFRESH_INTERVAL_MS : MIN_REFRESH_INTERVAL_MS);
  if (isFresh && !forceRefresh) return { snapshot: cache.snapshot, stale: false };
  if (refreshThrottled) return { snapshot: cache.snapshot, stale: now - cache.cachedAt >= HOLDER_CACHE_TTL_MS };
  if (!cache.snapshot && !cache.pending && cache.lastAttemptAt > 0 && now - cache.lastAttemptAt < MIN_REFRESH_INTERVAL_MS) {
    throw new Error("Arc RPC rate limit cooldown is active.");
  }

  if (!cache.pending) {
    cache.lastAttemptAt = now;
    cache.pending = loadHolderSnapshot(tokenAddress, hint)
      .then((snapshot) => {
        cache.snapshot = snapshot;
        cache.cachedAt = Date.now();
        cache.canonicalCheckedAt = Date.now();
        void writePersistentSnapshot(persistentKey, snapshot);
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

export function isHolderRpcError(error: unknown) {
  return isRetryableRpcError(error);
}
