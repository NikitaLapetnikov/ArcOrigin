import { decodeEventLog, formatUnits, getAddress, parseAbiItem } from "viem";
import { arcTestnet } from "@/lib/chains";
import { usesPermanentLiquidityMode } from "@/lib/bonding-curve";
import { getArcscanLogs } from "@/lib/onchain/arcscan-logs";
import type { ChartPoint, TokenData, Trade } from "@/lib/types";

const tokenBoughtEvent = parseAbiItem("event TokenBought(address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 fee)");
const tokenSoldEvent = parseAbiItem("event TokenSold(address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 fee)");
const tradeEvents = [tokenBoughtEvent, tokenSoldEvent] as const;
const CHART_TRADE_LIMIT = 240;
const TRADE_FEED_LIMIT = 500;

export type MarketSnapshot = {
  price: number;
  priceChange: number;
  marketCap: number;
  volume: number;
  buyers: number;
  sellers: number;
  raisedUsdc: number;
  targetUsdc: number;
  progress: number;
  graduated: boolean;
  tokensSold: number;
  tokenReserve: number;
  chart: ChartPoint[];
  trades: Trade[];
  indexedBlock: string;
  generatedAt: string;
};

type IndexedTrade = {
  blockNumber: bigint;
  logIndex: number;
  hash: `0x${string}`;
  wallet: `0x${string}`;
  type: "Buy" | "Sell";
  usdc: number;
  notional: number;
  reserveUsdcDelta: number;
  tokens: number;
  timestamp: number;
};

type IndexedPriceTick = {
  event: IndexedTrade;
  price: number;
};

function roundUsdc(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function getLatestBlockNumber() {
  const response = await fetch(arcTestnet.rpcUrls.default.http[0], {
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(6_000),
  });
  const payload = await response.json() as { result?: string };
  if (!response.ok || typeof payload.result !== "string" || !/^0x[0-9a-fA-F]+$/.test(payload.result)) {
    throw new Error("Arc Testnet block number is unavailable.");
  }
  return BigInt(payload.result);
}

export async function loadIndexedMarketSnapshot(token: TokenData, indexedBlock?: bigint): Promise<MarketSnapshot> {
  if (!token.curveAddress
    || token.launchBlock === undefined
    || token.totalSupply === undefined
    || token.creatorAllocationPercent === undefined
    || token.virtualUsdcReserve === undefined) {
    throw new Error("Factory token configuration is incomplete.");
  }
  const finalBlock = indexedBlock ?? await getLatestBlockNumber();
  const logs = await getArcscanLogs({
    address: getAddress(token.curveAddress),
    fromBlock: BigInt(token.launchBlock),
    toBlock: finalBlock,
  });
  const events: IndexedTrade[] = [];
  for (const log of logs) {
    let decoded;
    try {
      decoded = decodeEventLog({ abi: tradeEvents, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    events.push(decoded.eventName === "TokenBought" ? {
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      hash: log.transactionHash,
      wallet: decoded.args.buyer,
      type: "Buy",
      usdc: Number(formatUnits(decoded.args.usdcIn, 6)),
      notional: Number(formatUnits(decoded.args.usdcIn, 6)),
      reserveUsdcDelta: Number(formatUnits(decoded.args.usdcIn - decoded.args.fee, 6)),
      tokens: Number(formatUnits(decoded.args.tokensOut, 18)),
      timestamp: log.timestamp,
    } : {
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      hash: log.transactionHash,
      wallet: decoded.args.seller,
      type: "Sell",
      usdc: Number(formatUnits(decoded.args.usdcOut, 6)),
      notional: Number(formatUnits(decoded.args.usdcOut + decoded.args.fee, 6)),
      reserveUsdcDelta: -Number(formatUnits(decoded.args.usdcOut + decoded.args.fee, 6)),
      tokens: Number(formatUnits(decoded.args.tokensIn, 18)),
      timestamp: log.timestamp,
    });
  }

  const validEvents = events.filter((event) => event.tokens > 0).sort((left, right) => left.blockNumber === right.blockNumber
    ? left.logIndex - right.logIndex
    : left.blockNumber < right.blockNumber ? -1 : 1);
  const totalSupply = token.totalSupply;
  const initialReserve = totalSupply * (1 - token.creatorAllocationPercent / 100);
  const virtualUsdc = token.virtualUsdcReserve;
  const targetUsdc = token.targetUSDC;
  if (initialReserve <= 0 || virtualUsdc <= 0 || targetUsdc <= 0) {
    throw new Error("Factory token configuration is invalid.");
  }

  let tokenReserve = initialReserve;
  let tokensDistributed = 0;
  let raisedUsdc = 0;
  let graduated = false;
  const permanentLiquidityMode = usesPermanentLiquidityMode(virtualUsdc, targetUsdc);
  const priceTicks: IndexedPriceTick[] = [];
  for (const event of validEvents) {
    tokenReserve += event.type === "Buy" ? -event.tokens : event.tokens;
    tokensDistributed += event.type === "Buy" ? event.tokens : -event.tokens;
    raisedUsdc = roundUsdc(Math.max(0, raisedUsdc + event.reserveUsdcDelta));
    if (tokenReserve <= 0) throw new Error("Curve reserves are invalid.");
    if (!graduated && raisedUsdc >= targetUsdc) {
      graduated = true;
      if (permanentLiquidityMode) {
        tokenReserve = Math.ceil(raisedUsdc * tokenReserve / (virtualUsdc + raisedUsdc));
      }
    }
    priceTicks.push({
      event,
      price: (graduated && permanentLiquidityMode ? raisedUsdc : virtualUsdc + raisedUsdc) / tokenReserve,
    });
  }
  if (tokenReserve <= 0) throw new Error("Curve reserves are invalid.");

  const price = (graduated && permanentLiquidityMode ? raisedUsdc : virtualUsdc + raisedUsdc) / tokenReserve;
  const launchPrice = virtualUsdc / initialReserve;
  const chartTicks = priceTicks.slice(-CHART_TRADE_LIMIT);
  const trades: Trade[] = validEvents.slice(-TRADE_FEED_LIMIT).reverse().map((event) => ({
    time: `Block ${event.blockNumber.toString()}`,
    timestamp: event.timestamp,
    type: event.type,
    wallet: event.wallet,
    usdc: event.usdc,
    tokens: event.tokens,
    price: event.notional / event.tokens,
    txHash: event.hash,
  }));
  const chart: ChartPoint[] = [
    { time: "Launch", timestamp: token.launchedAt, price: launchPrice, volume: 0 },
    ...chartTicks.map(({ event, price: spotPrice }) => ({
      time: `#${(event.blockNumber % 100_000n).toString()}`,
      timestamp: event.timestamp,
      price: spotPrice,
      volume: event.notional,
    })),
  ];

  const cutoff24h = Math.floor(Date.now() / 1_000) - 24 * 60 * 60;
  const recentEvents = validEvents.filter((event) => event.timestamp >= cutoff24h);
  const firstTickInWindow = priceTicks.findIndex(({ event }) => event.timestamp >= cutoff24h);
  const comparisonPrice = firstTickInWindow < 0
    ? price
    : firstTickInWindow > 0
      ? priceTicks[firstTickInWindow - 1].price
      : launchPrice;

  return {
    price,
    priceChange: comparisonPrice > 0 ? (price / comparisonPrice - 1) * 100 : 0,
    marketCap: price * totalSupply,
    volume: recentEvents.reduce((sum, event) => roundUsdc(sum + event.notional), 0),
    buyers: recentEvents.filter((event) => event.type === "Buy").length,
    sellers: recentEvents.filter((event) => event.type === "Sell").length,
    raisedUsdc,
    targetUsdc,
    progress: raisedUsdc / targetUsdc * 100,
    graduated,
    tokensSold: Math.max(0, tokensDistributed),
    tokenReserve,
    chart,
    trades,
    indexedBlock: finalBlock.toString(),
    generatedAt: new Date().toISOString(),
  };
}
