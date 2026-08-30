import { decodeEventLog, formatUnits, parseAbiItem, toEventSelector, type Address } from "viem";
import {
  ARCORIGIN_PROTOCOL_VERSION,
  ARCORIGIN_V7_CROSS_MARKET_CAP_USDC,
  ARCORIGIN_V7_START_MARKET_CAP_USDC,
  ARC_ACTIVE_FACTORY,
  ARC_ACTIVE_FACTORY_INDEXES,
  arcChain,
} from "@/lib/chains";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import { getArcscanLogs } from "@/lib/onchain/arcscan-logs";
import { legacyGenesisToken } from "@/lib/onchain/legacy-genesis";
import { getVerifiedBootstrapTokens } from "@/lib/onchain/verified-bootstrap-tokens";
import { calculateRiskScore } from "@/lib/scoring";
import { normalizeTelegramUrl, normalizeWebsiteUrl, normalizeXUrl } from "@/lib/token-metadata";
import type { CreatorProfile, TokenData } from "@/lib/types";

const tokenLaunchedV6Event = parseAbiItem("event TokenLaunched(address indexed token, address indexed curve, address indexed creator, string name, string symbol)");
const tokenLaunchedV7Event = parseAbiItem("event TokenLaunched(address indexed token, address indexed pool, address indexed creator, string name, string symbol, uint256 positionId)");
const tokenLaunchedEvent = ARCORIGIN_PROTOCOL_VERSION === 7 ? tokenLaunchedV7Event : tokenLaunchedV6Event;
const tokenConfigAbi = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "metadataURI", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const curveConfigAbi = [
  { type: "function", name: "initialTokenReserve", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "virtualUsdcReserve", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "graduationThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const METADATA_TIMEOUT_MS = 10_000;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const FACTORY_LOG_BLOCK_RANGE = 9_999n;
const ACTIVE_FACTORY_INDEXES = ARC_ACTIVE_FACTORY_INDEXES.filter(
  (factory) => factory.address.toLowerCase() === ARC_ACTIVE_FACTORY.toLowerCase(),
);
const verifiedBootstrapByAddress = new Map(
  getVerifiedBootstrapTokens().map((token) => [token.address.toLowerCase(), token]),
);

type ClientLaunch = {
  factory: `0x${string}`;
  token: `0x${string}`;
  curve: `0x${string}`;
  venue: "curve" | "uniswap-v3";
  positionId?: bigint;
  creator: `0x${string}`;
  name: string;
  symbol: string;
  launchBlock: bigint;
  launchedAt: number;
  transactionHash: `0x${string}`;
};

function decodeLaunch(data: `0x${string}`, topics: readonly `0x${string}`[]) {
  if (ARCORIGIN_PROTOCOL_VERSION === 7) {
    const decoded = decodeEventLog({
      abi: [tokenLaunchedV7Event],
      data,
      topics: topics as [`0x${string}`, ...`0x${string}`[]],
    });
    return {
      token: decoded.args.token,
      curve: decoded.args.pool,
      creator: decoded.args.creator,
      name: decoded.args.name,
      symbol: decoded.args.symbol,
      venue: "uniswap-v3" as const,
      positionId: decoded.args.positionId,
    };
  }
  const decoded = decodeEventLog({
    abi: [tokenLaunchedV6Event],
    data,
    topics: topics as [`0x${string}`, ...`0x${string}`[]],
  });
  return {
    token: decoded.args.token,
    curve: decoded.args.curve,
    creator: decoded.args.creator,
    name: decoded.args.name,
    symbol: decoded.args.symbol,
    venue: "curve" as const,
    positionId: undefined,
  };
}

type ClientMetadata = {
  description?: string;
  image?: string;
  website?: string;
  x?: string;
  telegram?: string;
};

const publicClient = createArcPublicClient();

async function loadFactoryLaunches(
  factory: (typeof ACTIVE_FACTORY_INDEXES)[number],
  indexedBlock: bigint,
): Promise<ClientLaunch[]> {
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
        curve: decoded.curve,
        venue: decoded.venue,
        positionId: decoded.positionId,
        creator: decoded.creator,
        name: decoded.name,
        symbol: decoded.symbol,
        launchBlock: log.blockNumber,
        launchedAt: log.timestamp,
        transactionHash: log.transactionHash,
      };
    });
  } catch {
    // Explorer indexes are optional. Canonical RPC logs are the source of truth.
  }

  const launches: ClientLaunch[] = [];
  for (
    let fromBlock = factory.fromBlock;
    fromBlock <= indexedBlock;
    fromBlock += FACTORY_LOG_BLOCK_RANGE + 1n
  ) {
    const toBlock = fromBlock + FACTORY_LOG_BLOCK_RANGE < indexedBlock
      ? fromBlock + FACTORY_LOG_BLOCK_RANGE
      : indexedBlock;
    const logs = await publicClient.getLogs({
      address: factory.address,
      event: tokenLaunchedEvent,
      fromBlock,
      toBlock,
    });
    for (const log of logs) {
      const decoded = decodeLaunch(log.data, log.topics);
      launches.push({
        factory: factory.address,
        token: decoded.token as Address,
        curve: decoded.curve as Address,
        venue: decoded.venue,
        positionId: decoded.positionId,
        creator: decoded.creator as Address,
        name: decoded.name ?? "Indexed token",
        symbol: decoded.symbol ?? "TOKEN",
        launchBlock: log.blockNumber,
        launchedAt: 0,
        transactionHash: log.transactionHash,
      });
    }
  }

  const timestamps = new Map<string, number>();
  const uniqueBlocks = [...new Set(launches.map((launch) => launch.launchBlock.toString()))];
  for (let index = 0; index < uniqueBlocks.length; index += 8) {
    await Promise.all(uniqueBlocks.slice(index, index + 8).map(async (blockNumber) => {
      const block = await publicClient.getBlock({ blockNumber: BigInt(blockNumber) });
      timestamps.set(blockNumber, Number(block.timestamp));
    }));
  }
  return launches.map((launch) => ({
    ...launch,
    launchedAt: timestamps.get(launch.launchBlock.toString()) ?? 0,
  }));
}

function iconFor(name: string, symbol: string) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join("");
  return (initials || symbol.slice(0, 2) || "T").toUpperCase();
}

function createPendingToken(launch: ClientLaunch, creatorLaunches: number): TokenData {
  const verifiedToken = verifiedBootstrapByAddress.get(launch.token.toLowerCase());
  if (verifiedToken) {
    return {
      ...verifiedToken,
      name: launch.name,
      ticker: launch.symbol,
      address: launch.token,
      curveAddress: launch.curve,
      factoryAddress: launch.factory,
      creator: launch.creator,
      launchBlock: Number(launch.launchBlock),
      launchedAt: launch.launchedAt,
      ageMinutes: Math.max(0, Math.floor((Date.now() / 1_000 - launch.launchedAt) / 60)),
      launchTxHash: launch.transactionHash,
      creatorProfile: { ...verifiedToken.creatorProfile, launches: creatorLaunches },
    };
  }
  return {
    name: launch.name,
    ticker: launch.symbol,
    icon: iconFor(launch.name, launch.symbol),
    address: launch.token,
    curveAddress: launch.curve,
    poolAddress: launch.venue === "uniswap-v3" ? launch.curve : undefined,
    venue: launch.venue,
    factoryAddress: launch.factory,
    creator: launch.creator,
    source: "onchain",
    launchTxHash: launch.transactionHash,
    launchBlock: Number(launch.launchBlock),
    launchedAt: launch.launchedAt,
    description: "Verified ArcOrigin Factory launch. Loading immutable token configuration.",
    ageMinutes: Math.max(0, Math.floor((Date.now() / 1_000 - launch.launchedAt) / 60)),
    price: 0,
    priceChange24h: 0,
    marketCap: 0,
    raisedUSDC: 0,
    targetUSDC: 0,
    volume5m: 0,
    volume1h: 0,
    volume24h: 0,
    buyers: 0,
    sellers: 0,
    trades: 0,
    holders: 0,
    curveProgress: 0,
    riskScore: 0,
    status: launch.venue === "uniswap-v3" ? "Live on V3" : "Live on curve",
    chartData: [],
    recentTrades: [],
    riskLabels: [],
    creatorProfile: {
      address: launch.creator,
      reputation: creatorLaunches > 1 ? 55 : 50,
      launches: creatorLaunches,
      graduated: 0,
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

function ipfsURLs(uri: string) {
  const pinataURL = ipfsURL(uri);
  if (!pinataURL) return [];
  return [
    pinataURL,
    pinataURL.replace("https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/"),
  ];
}

function metadataText(value: unknown, maxLength: number) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maxLength
    ? value.trim()
    : undefined;
}

function metadataDescription(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function loadMetadata(metadataURI: string): Promise<ClientMetadata | null> {
  const urls = ipfsURLs(metadataURI);
  if (urls.length === 0) return null;
  try {
    const payload = await Promise.any(urls.map(async (url) => {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error("Metadata gateway rejected the request.");
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > MAX_METADATA_BYTES || !response.body) throw new Error("Invalid metadata response.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_METADATA_BYTES) {
          await reader.cancel();
          throw new Error("Metadata is too large.");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    }));
    const properties = payload.properties && typeof payload.properties === "object"
      ? payload.properties as Record<string, unknown>
      : {};
    const websiteValue = metadataText(payload.external_url, 200) ?? metadataText(properties.website, 200) ?? "";
    const xValue = metadataText(properties.x, 200) ?? "";
    const telegramValue = metadataText(properties.telegram, 200) ?? "";
    return {
      description: metadataDescription(payload.description),
      image: ipfsURL(metadataText(payload.image, 512) ?? "") || undefined,
      website: websiteValue ? normalizeWebsiteUrl(websiteValue) : undefined,
      x: xValue ? normalizeXUrl(xValue) : undefined,
      telegram: telegramValue ? normalizeTelegramUrl(telegramValue) : undefined,
    };
  } catch {
    return null;
  }
}

async function hydrateLaunch(launch: ClientLaunch, creatorLaunches: number): Promise<TokenData> {
  if (launch.token.toLowerCase() === legacyGenesisToken.address.toLowerCase()) {
    return {
      ...legacyGenesisToken,
      name: launch.name,
      ticker: launch.symbol,
      address: launch.token,
      curveAddress: launch.curve,
      factoryAddress: launch.factory,
      creator: launch.creator,
      launchBlock: Number(launch.launchBlock),
      launchedAt: launch.launchedAt,
      ageMinutes: Math.max(0, Math.floor((Date.now() / 1_000 - launch.launchedAt) / 60)),
      launchTxHash: launch.transactionHash,
      creatorProfile: { ...legacyGenesisToken.creatorProfile, launches: creatorLaunches },
    };
  }

  if (launch.venue === "uniswap-v3") {
    const [totalSupplyRaw, metadataURI] = await publicClient.multicall({
      allowFailure: false,
      multicallAddress: MULTICALL3_ADDRESS,
      contracts: [
        { address: launch.token, abi: tokenConfigAbi, functionName: "totalSupply" },
        { address: launch.token, abi: tokenConfigAbi, functionName: "metadataURI" },
      ],
    });
    const metadata = await loadMetadata(metadataURI);
    const totalSupply = Number(formatUnits(totalSupplyRaw, 18));
    if (totalSupply <= 0) throw new Error("Factory V7 token supply is invalid.");
    const launchPrice = ARCORIGIN_V7_START_MARKET_CAP_USDC / totalSupply;
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
      image: metadata?.image,
      metadataURI,
      curveAddress: undefined,
      poolAddress: launch.curve,
      positionId: launch.positionId?.toString(),
      venue: "uniswap-v3",
      creatorAllocationPercent: 0,
      totalSupply,
      description: metadata?.description ?? `ArcOrigin V7 launch indexed from ${arcChain.name} Uniswap V3 events.`,
      price: launchPrice,
      marketCap: ARCORIGIN_V7_START_MARKET_CAP_USDC,
      raisedUSDC: ARCORIGIN_V7_START_MARKET_CAP_USDC,
      targetUSDC: ARCORIGIN_V7_CROSS_MARKET_CAP_USDC,
      curveProgress: ARCORIGIN_V7_START_MARKET_CAP_USDC / ARCORIGIN_V7_CROSS_MARKET_CAP_USDC * 100,
      riskScore: risk.score,
      status: "Live on V3",
      chartData: [{ time: "Launch", timestamp: launch.launchedAt, price: launchPrice, volume: 0 }],
      riskLabels: risk.labels,
      socials: { website: metadata?.website, x: metadata?.x, telegram: metadata?.telegram },
    };
  }

  const [totalSupplyRaw, metadataURI, initialReserveRaw, virtualUsdcRaw, graduationRaw] = await publicClient.multicall({
    allowFailure: false,
    multicallAddress: MULTICALL3_ADDRESS,
    contracts: [
      { address: launch.token, abi: tokenConfigAbi, functionName: "totalSupply" },
      { address: launch.token, abi: tokenConfigAbi, functionName: "metadataURI" },
      { address: launch.curve, abi: curveConfigAbi, functionName: "initialTokenReserve" },
      { address: launch.curve, abi: curveConfigAbi, functionName: "virtualUsdcReserve" },
      { address: launch.curve, abi: curveConfigAbi, functionName: "graduationThreshold" },
    ],
  });
  const metadata = await loadMetadata(metadataURI);
  const totalSupply = Number(formatUnits(totalSupplyRaw, 18));
  const initialReserve = Number(formatUnits(initialReserveRaw, 18));
  const creatorAllocationPercent = totalSupply > 0 ? (totalSupply - initialReserve) / totalSupply * 100 : 0;
  const virtualUsdcReserve = Number(formatUnits(virtualUsdcRaw, 6));
  const targetUSDC = Number(formatUnits(graduationRaw, 6));
  if (totalSupply <= 0 || initialReserve <= 0 || virtualUsdcReserve <= 0 || targetUSDC <= 0) {
    throw new Error("Factory token configuration is invalid.");
  }
  const risk = calculateRiskScore({
    fixedSupply: true,
    standardTemplate: true,
    noBlacklist: true,
    noHiddenMint: true,
    creatorAllocationPercent,
    socialsPresent: Boolean(metadata?.website || metadata?.x),
    verifiedTemplate: true,
    holderConcentrationKnown: false,
    topTenHolderPercent: 100,
    previousCleanLaunches: 0,
  });
  const creatorProfile: CreatorProfile = {
    address: launch.creator,
    reputation: creatorLaunches > 1 ? 55 : 50,
    launches: creatorLaunches,
    graduated: 0,
    flagged: 0,
    totalVolume: 0,
    totalFees: 10,
    verified: false,
  };
  const launchPrice = virtualUsdcReserve / initialReserve;
  return {
    name: launch.name,
    ticker: launch.symbol,
    icon: iconFor(launch.name, launch.symbol),
    image: metadata?.image,
    metadataURI,
    address: launch.token,
    curveAddress: launch.curve,
    venue: "curve",
    factoryAddress: launch.factory,
    creator: launch.creator,
    source: "onchain",
    creatorAllocationPercent,
    launchTxHash: launch.transactionHash,
    launchBlock: Number(launch.launchBlock),
    launchedAt: launch.launchedAt,
    totalSupply,
    virtualUsdcReserve,
    description: metadata?.description ?? `ArcOrigin factory launch indexed from ${arcChain.name} events.`,
    ageMinutes: Math.max(0, Math.floor((Date.now() / 1_000 - launch.launchedAt) / 60)),
    price: launchPrice,
    priceChange24h: 0,
    marketCap: launchPrice * totalSupply,
    raisedUSDC: 0,
    targetUSDC,
    volume5m: 0,
    volume1h: 0,
    volume24h: 0,
    buyers: 0,
    sellers: 0,
    trades: 0,
    holders: 0,
    curveProgress: 0,
    riskScore: risk.score,
    status: "Live on curve",
    chartData: [{ time: "Launch", timestamp: launch.launchedAt, price: launchPrice, volume: 0 }],
    recentTrades: [],
    riskLabels: risk.labels,
    creatorProfile,
    socials: { website: metadata?.website, x: metadata?.x, telegram: metadata?.telegram },
  };
}

export async function loadClientTokenIndex(
  onLaunchesLoaded?: (snapshot: { tokens: TokenData[]; indexedBlock: string; generatedAt: string }) => void,
) {
  const indexedBlock = await publicClient.getBlockNumber();
  const launches = (await Promise.all(
    ACTIVE_FACTORY_INDEXES.map((factory) => loadFactoryLaunches(factory, indexedBlock)),
  )).flat();
  if (launches.length === 0) throw new Error("No verified Factory launches were returned.");
  const creatorCounts = new Map<string, number>();
  for (const launch of launches) {
    const creator = launch.creator.toLowerCase();
    creatorCounts.set(creator, (creatorCounts.get(creator) ?? 0) + 1);
  }
  const reversedLaunches = launches.slice().sort((left, right) => left.launchBlock === right.launchBlock
    ? 0
    : left.launchBlock > right.launchBlock ? -1 : 1);
  const latestLaunchBlock = reversedLaunches.reduce(
    (highest, launch) => launch.launchBlock > highest ? launch.launchBlock : highest,
    0n,
  );
  onLaunchesLoaded?.({
    tokens: reversedLaunches.map((launch) => createPendingToken(
      launch,
      creatorCounts.get(launch.creator.toLowerCase()) ?? 1,
    )),
    indexedBlock: latestLaunchBlock.toString(),
    generatedAt: new Date().toISOString(),
  });
  const tokensPromise = (async () => {
    const hydratedTokens: TokenData[] = [];
    for (let index = 0; index < reversedLaunches.length; index += 2) {
      hydratedTokens.push(...await Promise.all(reversedLaunches.slice(index, index + 2).map((launch) => hydrateLaunch(
        launch,
        creatorCounts.get(launch.creator.toLowerCase()) ?? 1,
      ))));
    }
    return hydratedTokens;
  })();
  const tokens = await tokensPromise;
  return {
    tokens,
    indexedBlock: indexedBlock.toString(),
    generatedAt: new Date().toISOString(),
  };
}
