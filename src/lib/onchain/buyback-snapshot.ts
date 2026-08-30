import "server-only";

import { formatUnits, getAddress, isAddress, parseAbiItem, type Address, type Hash } from "viem";
import { ARC_ACTIVE_FACTORY, ARC_ACTIVE_FACTORY_BLOCK, ARCORIGIN_NETWORK } from "@/lib/chains";
import { factoryAbi, liquidityLockerAbi } from "@/lib/contracts";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import { FactoryTokenNotFoundError } from "@/lib/onchain/holder-snapshot";
import { getTokenIndexSnapshotForToken } from "@/lib/onchain/token-index-snapshot";

const buybackExecutedEvent = parseAbiItem("event BuybackExecuted(uint256 indexed positionId, address indexed keeper, uint256 quoteSpent, uint256 keeperReward, uint256 launchTokensBurned, uint256 remainingQuoteReserve)");
const LOG_BLOCK_RANGE = 9_999n;
const CACHE_TTL_MS = 20_000;

export type BuybackExecution = {
  txHash: Hash;
  blockNumber: string;
  timestamp: number;
  keeper: Address;
  usdcSpent: number;
  keeperRewardUsdc: number;
  tokensBurned: number;
};

export type BuybackSnapshot = {
  enabled: boolean;
  ready: boolean;
  reserveUsdc: number;
  nextExecutionAt: number;
  totalUsdcSpent: number;
  totalTokensBurned: number;
  executionCount: number;
  latestExecution: BuybackExecution | null;
  keeper: {
    address: Address;
    balanceUsdc: number;
    platform: boolean;
  } | null;
  indexedBlock: string;
  generatedAt: string;
};

type CacheEntry = { snapshot: BuybackSnapshot; cachedAt: number };

const publicClient = createArcPublicClient(
  ARCORIGIN_NETWORK === "mainnet" ? process.env.ARC_MAINNET_RPC_URL : process.env.ARC_TESTNET_RPC_URL,
);
const cache = new Map<string, CacheEntry>();

async function readBuybackEvents(locker: Address, positionId: bigint, indexedBlock: bigint) {
  const events: Array<{
    txHash: Hash;
    blockNumber: bigint;
    keeper: Address;
    quoteSpent: bigint;
    keeperReward: bigint;
    launchTokensBurned: bigint;
  }> = [];
  for (let fromBlock = ARC_ACTIVE_FACTORY_BLOCK; fromBlock <= indexedBlock; fromBlock += LOG_BLOCK_RANGE + 1n) {
    const toBlock = fromBlock + LOG_BLOCK_RANGE < indexedBlock ? fromBlock + LOG_BLOCK_RANGE : indexedBlock;
    const logs = await publicClient.getLogs({
      address: locker,
      event: buybackExecutedEvent,
      args: { positionId },
      fromBlock,
      toBlock,
    });
    for (const log of logs) {
      if (!log.transactionHash || log.blockNumber === null) continue;
      events.push({
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        keeper: getAddress(log.args.keeper as Address),
        quoteSpent: log.args.quoteSpent ?? 0n,
        keeperReward: log.args.keeperReward ?? 0n,
        launchTokensBurned: log.args.launchTokensBurned ?? 0n,
      });
    }
  }
  return events.sort((left, right) => left.blockNumber < right.blockNumber ? -1 : left.blockNumber > right.blockNumber ? 1 : 0);
}

function configuredKeeperAddress() {
  const value = process.env.BUYBACK_KEEPER_ADDRESS?.trim();
  return value && isAddress(value) ? getAddress(value) : null;
}

export async function getBuybackSnapshot(tokenAddress: Address, forceRefresh = false) {
  const cacheKey = tokenAddress.toLowerCase();
  const cached = cache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.snapshot;

  const indexResult = await getTokenIndexSnapshotForToken(tokenAddress, forceRefresh);
  const token = indexResult.snapshot?.tokens.find((item) => item.address.toLowerCase() === cacheKey);
  if (!token) throw new FactoryTokenNotFoundError("Token was not launched by the configured ArcOrigin factory.");
  const indexedBlock = forceRefresh ? await publicClient.getBlockNumber() : BigInt(indexResult.snapshot?.indexedBlock ?? 0);

  if (!token.automaticBuyback || !token.positionId) {
    const snapshot: BuybackSnapshot = {
      enabled: false,
      ready: false,
      reserveUsdc: 0,
      nextExecutionAt: 0,
      totalUsdcSpent: 0,
      totalTokensBurned: 0,
      executionCount: 0,
      latestExecution: null,
      keeper: null,
      indexedBlock: indexedBlock.toString(),
      generatedAt: new Date().toISOString(),
    };
    cache.set(cacheKey, { snapshot, cachedAt: Date.now() });
    return snapshot;
  }

  const locker = getAddress(await publicClient.readContract({
    address: ARC_ACTIVE_FACTORY,
    abi: factoryAbi,
    functionName: "liquidityLocker",
  }));
  const positionId = BigInt(token.positionId);
  const [readyState, events] = await Promise.all([
    publicClient.readContract({
      address: locker,
      abi: liquidityLockerAbi,
      functionName: "buybackReady",
      args: [positionId],
      blockNumber: indexedBlock,
    }),
    readBuybackEvents(locker, positionId, indexedBlock),
  ]);
  const latestEvent = events.at(-1);
  const configuredKeeper = configuredKeeperAddress();
  const keeperAddress = configuredKeeper ?? latestEvent?.keeper ?? null;
  const [latestBlock, keeperBalance] = await Promise.all([
    latestEvent ? publicClient.getBlock({ blockNumber: latestEvent.blockNumber }) : null,
    keeperAddress ? publicClient.getBalance({ address: keeperAddress, blockNumber: indexedBlock }) : null,
  ]);
  const latestExecution: BuybackExecution | null = latestEvent ? {
    txHash: latestEvent.txHash,
    blockNumber: latestEvent.blockNumber.toString(),
    timestamp: Number(latestBlock?.timestamp ?? 0n),
    keeper: latestEvent.keeper,
    usdcSpent: Number(formatUnits(latestEvent.quoteSpent, 6)),
    keeperRewardUsdc: Number(formatUnits(latestEvent.keeperReward, 6)),
    tokensBurned: Number(formatUnits(latestEvent.launchTokensBurned, 18)),
  } : null;
  const snapshot: BuybackSnapshot = {
    enabled: true,
    ready: readyState[0],
    reserveUsdc: Number(formatUnits(readyState[1], 6)),
    nextExecutionAt: Number(readyState[2]),
    totalUsdcSpent: events.reduce((total, event) => total + Number(formatUnits(event.quoteSpent, 6)), 0),
    totalTokensBurned: events.reduce((total, event) => total + Number(formatUnits(event.launchTokensBurned, 18)), 0),
    executionCount: events.length,
    latestExecution,
    keeper: keeperAddress && keeperBalance !== null ? {
      address: keeperAddress,
      balanceUsdc: Number(formatUnits(keeperBalance, 18)),
      platform: configuredKeeper !== null,
    } : null,
    indexedBlock: indexedBlock.toString(),
    generatedAt: new Date().toISOString(),
  };
  cache.set(cacheKey, { snapshot, cachedAt: Date.now() });
  return snapshot;
}
