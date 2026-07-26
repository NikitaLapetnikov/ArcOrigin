import "server-only";

import { formatUnits, keccak256, parseAbiItem, toHex, type Address, type Hash } from "viem";
import {
  ARC_TESTNET_CONTRACTS,
  ARC_TESTNET_FIRST_LAUNCH_BLOCK,
  ARC_TESTNET_V4_FACTORY,
  ARC_TESTNET_V4_FACTORY_BLOCK,
} from "@/lib/chains";
import { erc20Abi } from "@/lib/contracts";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import { readPersistentSnapshot, writePersistentSnapshot } from "@/lib/server/persistent-cache";

const feeReceivedEvent = parseAbiItem("event FeeReceived(address indexed asset, address indexed payer, bytes32 indexed feeType, uint256 amount)");
const feeWithdrawnEvent = parseAbiItem("event FeeWithdrawn(address indexed asset, address indexed recipient, uint256 amount)");
const tokenLaunchedEvent = parseAbiItem("event TokenLaunched(address indexed token, address indexed curve, address indexed creator, string name, string symbol)");
const feeSplitEvent = parseAbiItem("event FeeSplit(address indexed payer, bytes32 indexed feeType, address indexed creator, uint256 creatorAmount, uint256 protocolAmount)");
const feeTypes = {
  [keccak256(toHex("LAUNCH_FEE"))]: "Launch",
  [keccak256(toHex("BUY_FEE"))]: "Buy",
  [keccak256(toHex("SELL_FEE"))]: "Sell",
} as const;

export type FeeSource = "Launch" | "Buy" | "Sell" | "Other";

export type FeeRow = {
  blockNumber: string;
  logIndex: number;
  source: FeeSource | "Withdrawal";
  amount: number;
  account: Address;
  transactionHash: Hash;
};

export type FeeSnapshot = {
  totalCollected: number;
  vaultBalance: number;
  launchFees: number;
  buyFees: number;
  sellFees: number;
  creatorTradingFees: number;
  chart: Array<{ block: string; revenue: number }>;
  rows: FeeRow[];
  indexedBlock: string;
  generatedAt: string;
};

type FeeCache = {
  snapshot: FeeSnapshot | null;
  cachedAt: number;
  lastAttemptAt: number;
  pending: Promise<FeeSnapshot> | null;
};

const CACHE_TTL_MS = 30_000;
const MIN_REFRESH_INTERVAL_MS = 10_000;
const LOG_BLOCK_RANGE = 9_999n;
const PERSISTENT_CACHE_KEY = "arcorigin:v4:fees";
const publicClient = createArcPublicClient(process.env.ARC_TESTNET_RPC_URL);

declare global {
  var __arcOriginFeeCache: FeeCache | undefined;
}

const cache = globalThis.__arcOriginFeeCache ?? {
  snapshot: null,
  cachedAt: 0,
  lastAttemptAt: 0,
  pending: null,
};
globalThis.__arcOriginFeeCache = cache;

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
      await wait(attempt * 750);
    }
  }
  throw new Error("Arc RPC request failed after retries.");
}

function sourceFor(feeType: Hash): FeeSource {
  return feeTypes[feeType as keyof typeof feeTypes] ?? "Other";
}

function roundUsdc(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function loadFeeSnapshot(): Promise<FeeSnapshot> {
  const indexedBlock = await withRpcRetry(() => publicClient.getBlockNumber());
  const feeLogs = [];
  for (let fromBlock = ARC_TESTNET_FIRST_LAUNCH_BLOCK; fromBlock <= indexedBlock; fromBlock += LOG_BLOCK_RANGE + 1n) {
    const toBlock = fromBlock + LOG_BLOCK_RANGE < indexedBlock ? fromBlock + LOG_BLOCK_RANGE : indexedBlock;
    const logs = await withRpcRetry(() => publicClient.getLogs({
      address: ARC_TESTNET_CONTRACTS.feeVault,
      events: [feeReceivedEvent, feeWithdrawnEvent],
      fromBlock,
      toBlock,
    }));
    feeLogs.push(...logs);
  }
  const vaultBalanceRaw = await withRpcRetry(() => publicClient.readContract({
    address: ARC_TESTNET_CONTRACTS.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [ARC_TESTNET_CONTRACTS.feeVault],
    blockNumber: indexedBlock,
  }));
  const v4Curves: Address[] = [];
  for (let fromBlock = ARC_TESTNET_V4_FACTORY_BLOCK; fromBlock <= indexedBlock; fromBlock += LOG_BLOCK_RANGE + 1n) {
    const toBlock = fromBlock + LOG_BLOCK_RANGE < indexedBlock ? fromBlock + LOG_BLOCK_RANGE : indexedBlock;
    const launches = await withRpcRetry(() => publicClient.getLogs({
      address: ARC_TESTNET_V4_FACTORY,
      event: tokenLaunchedEvent,
      fromBlock,
      toBlock,
    }));
    for (const launch of launches) {
      if (launch.args.curve) v4Curves.push(launch.args.curve);
    }
  }
  let creatorTradingFees = 0;
  for (let offset = 0; offset < v4Curves.length; offset += 50) {
    const curves = v4Curves.slice(offset, offset + 50);
    for (let fromBlock = ARC_TESTNET_V4_FACTORY_BLOCK; fromBlock <= indexedBlock; fromBlock += LOG_BLOCK_RANGE + 1n) {
      const toBlock = fromBlock + LOG_BLOCK_RANGE < indexedBlock ? fromBlock + LOG_BLOCK_RANGE : indexedBlock;
      const splits = await withRpcRetry(() => publicClient.getLogs({
        address: curves,
        event: feeSplitEvent,
        fromBlock,
        toBlock,
      }));
      for (const split of splits) {
        creatorTradingFees = roundUsdc(
          creatorTradingFees + Number(formatUnits(split.args.creatorAmount ?? 0n, 6)),
        );
      }
    }
  }

  const receivedRows: FeeRow[] = [];
  const withdrawalRows: FeeRow[] = [];
  const usdcAddress = ARC_TESTNET_CONTRACTS.usdc.toLowerCase();
  for (const log of feeLogs) {
    if (log.args.asset?.toLowerCase() !== usdcAddress) continue;
    if (log.eventName === "FeeReceived") {
      receivedRows.push({
        blockNumber: (log.blockNumber ?? 0n).toString(),
        logIndex: log.logIndex ?? 0,
        source: sourceFor(log.args.feeType as Hash),
        amount: Number(formatUnits(log.args.amount ?? 0n, 6)),
        account: log.args.payer as Address,
        transactionHash: log.transactionHash as Hash,
      });
    } else {
      withdrawalRows.push({
        blockNumber: (log.blockNumber ?? 0n).toString(),
        logIndex: log.logIndex ?? 0,
        source: "Withdrawal",
        amount: Number(formatUnits(log.args.amount ?? 0n, 6)),
        account: log.args.recipient as Address,
        transactionHash: log.transactionHash as Hash,
      });
    }
  }
  const ascending = receivedRows.slice().sort((left, right) => {
    const leftBlock = BigInt(left.blockNumber);
    const rightBlock = BigInt(right.blockNumber);
    return leftBlock === rightBlock ? left.logIndex - right.logIndex : leftBlock < rightBlock ? -1 : 1;
  });
  let cumulative = 0;
  const chart = [{ block: "Start", revenue: 0 }, ...ascending.map((row) => {
    cumulative = roundUsdc(cumulative + row.amount);
    return { block: `#${(BigInt(row.blockNumber) % 100_000n).toString()}`, revenue: cumulative };
  })];
  const amountFor = (source: FeeSource) => receivedRows
    .filter((row) => row.source === source)
    .reduce((sum, row) => roundUsdc(sum + row.amount), 0);
  const rows = [...receivedRows, ...withdrawalRows].sort((left, right) => {
    const leftBlock = BigInt(left.blockNumber);
    const rightBlock = BigInt(right.blockNumber);
    return leftBlock === rightBlock ? right.logIndex - left.logIndex : leftBlock > rightBlock ? -1 : 1;
  });

  return {
    totalCollected: receivedRows.reduce((sum, row) => roundUsdc(sum + row.amount), 0),
    vaultBalance: Number(formatUnits(vaultBalanceRaw, 6)),
    launchFees: amountFor("Launch"),
    buyFees: amountFor("Buy"),
    sellFees: amountFor("Sell"),
    creatorTradingFees,
    chart,
    rows,
    indexedBlock: indexedBlock.toString(),
    generatedAt: new Date().toISOString(),
  };
}

export async function getFeeSnapshot(forceRefresh = false) {
  if (!cache.snapshot) {
    const persisted = await readPersistentSnapshot<FeeSnapshot>(PERSISTENT_CACHE_KEY);
    if (persisted?.indexedBlock && Array.isArray(persisted.rows)) {
      cache.snapshot = persisted;
      cache.cachedAt = Date.parse(persisted.generatedAt) || 0;
    }
  }
  const now = Date.now();
  const isFresh = cache.snapshot && now - cache.cachedAt < CACHE_TTL_MS;
  const refreshThrottled = !forceRefresh && cache.snapshot && now - cache.lastAttemptAt < MIN_REFRESH_INTERVAL_MS;
  if (isFresh && !forceRefresh) return { snapshot: cache.snapshot, stale: false };
  if (refreshThrottled) return { snapshot: cache.snapshot, stale: now - cache.cachedAt >= CACHE_TTL_MS };
  if (!cache.snapshot && !cache.pending && cache.lastAttemptAt > 0 && now - cache.lastAttemptAt < MIN_REFRESH_INTERVAL_MS) {
    throw new Error("Arc RPC rate limit cooldown is active.");
  }

  if (!cache.pending) {
    cache.lastAttemptAt = now;
    cache.pending = loadFeeSnapshot()
      .then((snapshot) => {
        cache.snapshot = snapshot;
        cache.cachedAt = Date.now();
        void writePersistentSnapshot(PERSISTENT_CACHE_KEY, snapshot);
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

export function isFeeRpcError(error: unknown) {
  return isRetryableRpcError(error);
}
