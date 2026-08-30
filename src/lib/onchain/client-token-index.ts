import { decodeEventLog, formatUnits, parseAbiItem, toEventSelector, type Address } from "viem";
import {
  ARCORIGIN_CROSS_MARKET_CAP_USDC,
  ARCORIGIN_START_MARKET_CAP_USDC,
  ARC_ACTIVE_FACTORY,
  ARC_ACTIVE_FACTORY_INDEXES,
  arcChain,
} from "@/lib/chains";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import { getArcscanLogs } from "@/lib/onchain/arcscan-logs";
import { calculateRiskScore } from "@/lib/scoring";
import { factoryAbi } from "@/lib/contracts";
import { normalizeTelegramUrl, normalizeWebsiteUrl, normalizeXUrl } from "@/lib/token-metadata";
import type { TokenData } from "@/lib/types";

const tokenLaunchedEvent = parseAbiItem("event TokenLaunched(address indexed token, address indexed pool, address indexed creator, string name, string symbol, uint256 positionId)");
const tokenConfigAbi = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "metadataURI", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const METADATA_TIMEOUT_MS = 10_000;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const FACTORY_LOG_BLOCK_RANGE = 9_999n;
const ACTIVE_FACTORY_INDEXES = ARC_ACTIVE_FACTORY_INDEXES.filter(
  (factory) => factory.address.toLowerCase() === ARC_ACTIVE_FACTORY.toLowerCase(),
);

type ClientLaunch = {
  factory: Address;
  token: Address;
  pool: Address;
  positionId: bigint;
  creator: Address;
  name: string;
  symbol: string;
  launchBlock: bigint;
  launchedAt: number;
  transactionHash: `0x${string}`;
};

type ClientMetadata = {
  description?: string;
  image?: string;
  website?: string;
  x?: string;
  telegram?: string;
};

const publicClient = createArcPublicClient();

function decodeLaunch(data: `0x${string}`, topics: readonly `0x${string}`[]) {
  const decoded = decodeEventLog({
    abi: [tokenLaunchedEvent],
    data,
    topics: topics as [`0x${string}`, ...`0x${string}`[]],
  });
  return decoded.args;
}

async function loadFactoryLaunches(factory: (typeof ACTIVE_FACTORY_INDEXES)[number], indexedBlock: bigint) {
  try {
    const logs = await getArcscanLogs({
      address: factory.address,
      fromBlock: factory.fromBlock,
      toBlock: indexedBlock,
      topic0: toEventSelector(tokenLaunchedEvent),
    });
    return logs.map((log) => {
      const decoded = decodeLaunch(log.data, log.topics);
      return {
        factory: factory.address,
        token: decoded.token,
        pool: decoded.pool,
        positionId: decoded.positionId,
        creator: decoded.creator,
        name: decoded.name,
        symbol: decoded.symbol,
        launchBlock: log.blockNumber,
        launchedAt: log.timestamp,
        transactionHash: log.transactionHash,
      } satisfies ClientLaunch;
    });
  } catch {
    // Arcscan is an optimization; canonical RPC logs remain the fallback.
  }

  const launches: ClientLaunch[] = [];
  for (let fromBlock = factory.fromBlock; fromBlock <= indexedBlock; fromBlock += FACTORY_LOG_BLOCK_RANGE + 1n) {
    const toBlock = fromBlock + FACTORY_LOG_BLOCK_RANGE < indexedBlock ? fromBlock + FACTORY_LOG_BLOCK_RANGE : indexedBlock;
    const logs = await publicClient.getLogs({ address: factory.address, event: tokenLaunchedEvent, fromBlock, toBlock });
    for (const log of logs) {
      launches.push({
        factory: factory.address,
        token: log.args.token as Address,
        pool: log.args.pool as Address,
        positionId: log.args.positionId ?? 0n,
        creator: log.args.creator as Address,
        name: log.args.name ?? "Indexed token",
        symbol: log.args.symbol ?? "TOKEN",
        launchBlock: log.blockNumber,
        launchedAt: 0,
        transactionHash: log.transactionHash,
      });
    }
  }
  const timestamps = new Map<string, number>();
  for (const blockNumber of [...new Set(launches.map((launch) => launch.launchBlock.toString()))]) {
    const block = await publicClient.getBlock({ blockNumber: BigInt(blockNumber) });
    timestamps.set(blockNumber, Number(block.timestamp));
  }
  return launches.map((launch) => ({ ...launch, launchedAt: timestamps.get(launch.launchBlock.toString()) ?? 0 }));
}

function iconFor(name: string, symbol: string) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join("");
  return (initials || symbol.slice(0, 2) || "T").toUpperCase();
}

function createPendingToken(launch: ClientLaunch, creatorLaunches: number): TokenData {
  return {
    name: launch.name,
    ticker: launch.symbol,
    icon: iconFor(launch.name, launch.symbol),
    address: launch.token,
    poolAddress: launch.pool,
    positionId: launch.positionId.toString(),
    factoryAddress: launch.factory,
    automaticBuyback: false,
    creator: launch.creator,
    source: "onchain",
    creatorAllocationPercent: 0,
    launchTxHash: launch.transactionHash,
    launchBlock: Number(launch.launchBlock),
    launchedAt: launch.launchedAt,
    description: "Verified ArcOrigin launch. Loading immutable token configuration.",
    ageMinutes: Math.max(0, Math.floor((Date.now() / 1_000 - launch.launchedAt) / 60)),
    price: 0,
    priceChange24h: 0,
    marketCap: 0,
    raisedUSDC: 0,
    targetUSDC: ARCORIGIN_CROSS_MARKET_CAP_USDC,
    volume5m: 0,
    volume1h: 0,
    volume24h: 0,
    buyers: 0,
    sellers: 0,
    trades: 0,
    holders: 0,
    crossProgress: 0,
    riskScore: 0,
    status: "Live",
    chartData: [],
    recentTrades: [],
    riskLabels: [],
    creatorProfile: {
      address: launch.creator,
      reputation: creatorLaunches > 1 ? 55 : 50,
      launches: creatorLaunches,
      crossed: 0,
      flagged: 0,
      totalVolume: 0,
      totalFees: 10,
      verified: false,
    },
    socials: {},
  };
}

function ipfsURL(uri: string) {
  const match = uri.trim().match(/^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]{40,120})(\/[^?#]*)?$/);
  return match && !match[2]?.split("/").includes("..")
    ? `https://gateway.pinata.cloud/ipfs/${match[1]}${match[2] ?? ""}`
    : "";
}

async function loadMetadata(metadataURI: string): Promise<ClientMetadata | null> {
  const pinataURL = ipfsURL(metadataURI);
  if (!pinataURL) return null;
  const urls = [pinataURL, pinataURL.replace("https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/")];
  try {
    const payload = await Promise.any(urls.map(async (url) => {
      const response = await fetch(url, { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
      if (!response.ok || !response.body) throw new Error("Metadata gateway rejected the request.");
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > MAX_METADATA_BYTES) throw new Error("Metadata is too large.");
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES) throw new Error("Metadata is too large.");
      return JSON.parse(text) as Record<string, unknown>;
    }));
    const properties = payload.properties && typeof payload.properties === "object" ? payload.properties as Record<string, unknown> : {};
    const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length <= max ? value.trim() : "";
    const website = text(payload.external_url, 200) || text(properties.website, 200);
    const x = text(properties.x, 200);
    const telegram = text(properties.telegram, 200);
    return {
      description: text(payload.description, 2_000) || undefined,
      image: ipfsURL(text(payload.image, 512)) || undefined,
      website: website ? normalizeWebsiteUrl(website) : undefined,
      x: x ? normalizeXUrl(x) : undefined,
      telegram: telegram ? normalizeTelegramUrl(telegram) : undefined,
    };
  } catch {
    return null;
  }
}

async function hydrateLaunch(launch: ClientLaunch, creatorLaunches: number): Promise<TokenData> {
  const [totalSupplyRaw, metadataURI, tokenInfo] = await publicClient.multicall({
    allowFailure: false,
    multicallAddress: MULTICALL3_ADDRESS,
    contracts: [
      { address: launch.token, abi: tokenConfigAbi, functionName: "totalSupply" },
      { address: launch.token, abi: tokenConfigAbi, functionName: "metadataURI" },
      { address: launch.factory, abi: factoryAbi, functionName: "getTokenInfo", args: [launch.token] },
    ],
  });
  if (tokenInfo.token.toLowerCase() !== launch.token.toLowerCase() || tokenInfo.pool.toLowerCase() !== launch.pool.toLowerCase()) {
    throw new Error("Factory token record does not match the indexed launch.");
  }
  const metadata = await loadMetadata(metadataURI);
  const totalSupply = Number(formatUnits(totalSupplyRaw, 18));
  if (totalSupply <= 0) throw new Error("Factory token supply is invalid.");
  const launchPrice = ARCORIGIN_START_MARKET_CAP_USDC / totalSupply;
  const risk = calculateRiskScore({
    fixedSupply: true,
    standardTemplate: true,
    noBlacklist: true,
    noHiddenMint: true,
    creatorAllocationPercent: 0,
    socialsPresent: Boolean(metadata?.website || metadata?.x),
    verifiedTemplate: true,
    holderConcentrationKnown: true,
    topTenHolderPercent: 0,
    previousCleanLaunches: 0,
  });
  return {
    ...createPendingToken(launch, creatorLaunches),
    automaticBuyback: tokenInfo.automaticBuyback,
    image: metadata?.image,
    metadataURI,
    totalSupply,
    description: metadata?.description ?? `ArcOrigin launch indexed from ${arcChain.name} Uniswap V3 events.`,
    price: launchPrice,
    marketCap: ARCORIGIN_START_MARKET_CAP_USDC,
    raisedUSDC: ARCORIGIN_START_MARKET_CAP_USDC,
    crossProgress: ARCORIGIN_START_MARKET_CAP_USDC / ARCORIGIN_CROSS_MARKET_CAP_USDC * 100,
    riskScore: risk.score,
    chartData: [{ time: "Launch", timestamp: launch.launchedAt, price: launchPrice, volume: 0 }],
    riskLabels: risk.labels,
    socials: { website: metadata?.website, x: metadata?.x, telegram: metadata?.telegram },
  };
}

export async function loadClientTokenIndex(
  onLaunchesLoaded?: (snapshot: { tokens: TokenData[]; indexedBlock: string; generatedAt: string }) => void,
) {
  const indexedBlock = await publicClient.getBlockNumber();
  const launches = (await Promise.all(ACTIVE_FACTORY_INDEXES.map((factory) => loadFactoryLaunches(factory, indexedBlock)))).flat();
  const creatorCounts = new Map<string, number>();
  for (const launch of launches) {
    const creator = launch.creator.toLowerCase();
    creatorCounts.set(creator, (creatorCounts.get(creator) ?? 0) + 1);
  }
  const newestFirst = launches.slice().sort((left, right) => left.launchBlock === right.launchBlock ? 0 : left.launchBlock > right.launchBlock ? -1 : 1);
  onLaunchesLoaded?.({
    tokens: newestFirst.map((launch) => createPendingToken(launch, creatorCounts.get(launch.creator.toLowerCase()) ?? 1)),
    indexedBlock: indexedBlock.toString(),
    generatedAt: new Date().toISOString(),
  });
  const tokens: TokenData[] = [];
  for (let index = 0; index < newestFirst.length; index += 2) {
    tokens.push(...await Promise.all(newestFirst.slice(index, index + 2).map((launch) => hydrateLaunch(
      launch,
      creatorCounts.get(launch.creator.toLowerCase()) ?? 1,
    ))));
  }
  return { tokens, indexedBlock: indexedBlock.toString(), generatedAt: new Date().toISOString() };
}
