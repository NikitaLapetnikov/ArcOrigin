import { decodeEventLog, formatUnits, getAddress, parseAbiItem } from "viem";
import { usesPermanentLiquidityMode } from "@/lib/bonding-curve";
import {
  ARCORIGIN_V7_CROSS_MARKET_CAP_USDC,
  ARCORIGIN_V7_START_MARKET_CAP_USDC,
} from "@/lib/chains";
import { erc20Abi, uniswapV3PoolAbi } from "@/lib/contracts";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import { getArcscanLogs } from "@/lib/onchain/arcscan-logs";
import type { ChartPoint, TokenData, Trade } from "@/lib/types";

const tokenBoughtEvent = parseAbiItem("event TokenBought(address indexed buyer, uint256 usdcIn, uint256 tokensOut, uint256 fee)");
const tokenSoldEvent = parseAbiItem("event TokenSold(address indexed seller, uint256 tokensIn, uint256 usdcOut, uint256 fee)");
const uniswapSwapEvent = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");
const tradeEvents = [tokenBoughtEvent, tokenSoldEvent] as const;
const CHART_TRADE_LIMIT = 240;
const TRADE_FEED_LIMIT = 500;
const publicClient = createArcPublicClient();

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

function uniswapPriceFromSqrt(sqrtPriceX96: bigint, tokenIsToken0: boolean) {
  const normalized = Number(sqrtPriceX96) / 2 ** 96;
  const rawToken1PerToken0 = normalized * normalized;
  const price = tokenIsToken0
    ? rawToken1PerToken0 * 1e12
    : 1e12 / rawToken1PerToken0;
  if (!Number.isFinite(price) || price <= 0) throw new Error("Uniswap pool price is invalid.");
  return price;
}

async function loadIndexedV3MarketSnapshot(
  token: TokenData,
  finalBlock: bigint,
): Promise<MarketSnapshot> {
  if (!token.poolAddress || token.launchBlock === undefined || token.totalSupply === undefined) {
    throw new Error("Factory V7 token configuration is incomplete.");
  }
  const pool = getAddress(token.poolAddress);
  const tokenAddress = getAddress(token.address);
  const logs = await getArcscanLogs({
    address: pool,
    fromBlock: BigInt(token.launchBlock),
    toBlock: finalBlock,
  });
  const [poolToken0, slot0, tokenReserveRaw] = await Promise.all([
    publicClient.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "token0", blockNumber: finalBlock }),
    publicClient.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "slot0", blockNumber: finalBlock }),
    publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [pool], blockNumber: finalBlock }),
  ]);
  const tokenIsToken0 = poolToken0.toLowerCase() === tokenAddress.toLowerCase();
  const events: IndexedTrade[] = [];
  for (const log of logs) {
    let decoded;
    try {
      decoded = decodeEventLog({ abi: [uniswapSwapEvent], data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    const tokenDelta = tokenIsToken0 ? decoded.args.amount0 : decoded.args.amount1;
    const usdcDelta = tokenIsToken0 ? decoded.args.amount1 : decoded.args.amount0;
    if (tokenDelta === 0n || usdcDelta === 0n || (tokenDelta < 0n) === (usdcDelta < 0n)) continue;
    const usdc = Number(formatUnits(usdcDelta < 0n ? -usdcDelta : usdcDelta, 6));
    const tokens = Number(formatUnits(tokenDelta < 0n ? -tokenDelta : tokenDelta, 18));
    events.push({
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      hash: log.transactionHash,
      wallet: decoded.args.recipient,
      type: tokenDelta < 0n ? "Buy" : "Sell",
      usdc,
      notional: usdc,
      reserveUsdcDelta: 0,
      tokens,
      timestamp: log.timestamp,
    });
  }
  const validEvents = events.filter((event) => event.tokens > 0).sort((left, right) => left.blockNumber === right.blockNumber
    ? left.logIndex - right.logIndex
    : left.blockNumber < right.blockNumber ? -1 : 1);
  const totalSupply = token.totalSupply;
  const price = uniswapPriceFromSqrt(slot0[0], tokenIsToken0);
  const launchPrice = ARCORIGIN_V7_START_MARKET_CAP_USDC / totalSupply;
  const marketCap = price * totalSupply;
  const priceTicks = validEvents.map((event) => ({ event, price: event.usdc / event.tokens }));
  const trades: Trade[] = validEvents.slice(-TRADE_FEED_LIMIT).reverse().map((event) => ({
    time: `Block ${event.blockNumber.toString()}`,
    timestamp: event.timestamp,
    type: event.type,
    wallet: event.wallet,
    usdc: event.usdc,
    tokens: event.tokens,
    price: event.usdc / event.tokens,
    txHash: event.hash,
  }));
  const cutoff24h = Math.floor(Date.now() / 1_000) - 24 * 60 * 60;
  const recentEvents = validEvents.filter((event) => event.timestamp >= cutoff24h);
  const firstTickInWindow = priceTicks.findIndex(({ event }) => event.timestamp >= cutoff24h);
  const comparisonPrice = firstTickInWindow < 0
    ? price
    : firstTickInWindow > 0 ? priceTicks[firstTickInWindow - 1].price : launchPrice;
  const tokenReserve = Number(formatUnits(tokenReserveRaw, 18));
  return {
    price,
    priceChange: comparisonPrice > 0 ? (price / comparisonPrice - 1) * 100 : 0,
    marketCap,
    volume: recentEvents.reduce((sum, event) => roundUsdc(sum + event.notional), 0),
    buyers: recentEvents.filter((event) => event.type === "Buy").length,
    sellers: recentEvents.filter((event) => event.type === "Sell").length,
    raisedUsdc: marketCap,
    targetUsdc: ARCORIGIN_V7_CROSS_MARKET_CAP_USDC,
    progress: Math.min(100, marketCap / ARCORIGIN_V7_CROSS_MARKET_CAP_USDC * 100),
    graduated: marketCap >= ARCORIGIN_V7_CROSS_MARKET_CAP_USDC,
    tokensSold: Math.max(0, totalSupply - tokenReserve),
    tokenReserve,
    chart: [
      { time: "Launch", timestamp: token.launchedAt, price: launchPrice, volume: 0 },
      ...priceTicks.slice(-CHART_TRADE_LIMIT).map(({ event, price: tickPrice }) => ({
        time: `#${(event.blockNumber % 100_000n).toString()}`,
        timestamp: event.timestamp,
        price: tickPrice,
        volume: event.notional,
      })),
    ],
    trades,
    indexedBlock: finalBlock.toString(),
    generatedAt: new Date().toISOString(),
  };
}

async function getLatestBlockNumber() {
  return publicClient.getBlockNumber();
}

export async function loadIndexedMarketSnapshot(token: TokenData, indexedBlock?: bigint): Promise<MarketSnapshot> {
  const finalBlock = indexedBlock ?? await getLatestBlockNumber();
  if (token.venue === "uniswap-v3") return loadIndexedV3MarketSnapshot(token, finalBlock);
  if (!token.curveAddress
    || token.launchBlock === undefined
    || token.totalSupply === undefined
    || token.creatorAllocationPercent === undefined
    || token.virtualUsdcReserve === undefined) {
    throw new Error("Factory token configuration is incomplete.");
  }
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
    progress: targetUsdc > 0 ? Math.min(100, raisedUsdc / targetUsdc * 100) : 0,
    graduated,
    tokensSold: Math.max(0, tokensDistributed),
    tokenReserve,
    chart,
    trades,
    indexedBlock: finalBlock.toString(),
    generatedAt: new Date().toISOString(),
  };
}
