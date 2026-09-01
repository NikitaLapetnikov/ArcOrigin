import { decodeEventLog, formatUnits, getAddress, parseAbiItem } from "viem";
import { ARCORIGIN_CROSS_MARKET_CAP_USDC, ARCORIGIN_START_MARKET_CAP_USDC } from "@/lib/chains";
import { erc20Abi, uniswapV3PoolAbi } from "@/lib/contracts";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import { getArcscanLogs } from "@/lib/onchain/arcscan-logs";
import type { ChartPoint, TokenData, Trade } from "@/lib/types";

const swapEvent = parseAbiItem("event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)");
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
  crossed: boolean;
  tokensSold: number;
  tokenReserve: number;
  chart: ChartPoint[];
  trades: Trade[];
  indexedBlock: string;
  generatedAt: string;
};

function priceFromSqrt(sqrtPriceX96: bigint, tokenIsToken0: boolean) {
  const normalized = Number(sqrtPriceX96) / 2 ** 96;
  const rawToken1PerToken0 = normalized * normalized;
  const price = tokenIsToken0 ? rawToken1PerToken0 * 1e12 : 1e12 / rawToken1PerToken0;
  if (!Number.isFinite(price) || price <= 0) throw new Error("Uniswap pool price is invalid.");
  return price;
}

export async function loadIndexedMarketSnapshot(token: TokenData, indexedBlock?: bigint): Promise<MarketSnapshot> {
  if (!token.poolAddress || token.launchBlock === undefined || token.totalSupply === undefined) {
    throw new Error("Factory token configuration is incomplete.");
  }
  const finalBlock = indexedBlock ?? await publicClient.getBlockNumber();
  const pool = getAddress(token.poolAddress);
  const tokenAddress = getAddress(token.address);
  const [logs, poolToken0, slot0, tokenReserveRaw] = await Promise.all([
    getArcscanLogs({ address: pool, fromBlock: BigInt(token.launchBlock), toBlock: finalBlock }),
    publicClient.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "token0", blockNumber: finalBlock }),
    publicClient.readContract({ address: pool, abi: uniswapV3PoolAbi, functionName: "slot0", blockNumber: finalBlock }),
    publicClient.readContract({ address: tokenAddress, abi: erc20Abi, functionName: "balanceOf", args: [pool], blockNumber: finalBlock }),
  ]);
  const tokenIsToken0 = poolToken0.toLowerCase() === tokenAddress.toLowerCase();
  const events: Array<Trade & { blockNumber: bigint; logIndex: number; timestamp: number; executionPrice: number }> = [];
  for (const log of logs) {
    let decoded;
    try {
      decoded = decodeEventLog({ abi: [swapEvent], data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    const tokenDelta = tokenIsToken0 ? decoded.args.amount0 : decoded.args.amount1;
    const usdcDelta = tokenIsToken0 ? decoded.args.amount1 : decoded.args.amount0;
    if (tokenDelta === 0n || usdcDelta === 0n || (tokenDelta < 0n) === (usdcDelta < 0n)) continue;
    const usdc = Number(formatUnits(usdcDelta < 0n ? -usdcDelta : usdcDelta, 6));
    const tokens = Number(formatUnits(tokenDelta < 0n ? -tokenDelta : tokenDelta, 18));
    if (tokens <= 0) continue;
    events.push({
      time: `Block ${log.blockNumber}`,
      timestamp: log.timestamp,
      type: tokenDelta < 0n ? "Buy" : "Sell",
      wallet: decoded.args.recipient,
      usdc,
      tokens,
      price: usdc / tokens,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      executionPrice: priceFromSqrt(decoded.args.sqrtPriceX96, tokenIsToken0),
    });
  }
  events.sort((left, right) => left.blockNumber === right.blockNumber ? left.logIndex - right.logIndex : left.blockNumber < right.blockNumber ? -1 : 1);
  const price = priceFromSqrt(slot0[0], tokenIsToken0);
  const launchPrice = ARCORIGIN_START_MARKET_CAP_USDC / token.totalSupply;
  const marketCap = price * token.totalSupply;
  const cutoff24h = Math.floor(Date.now() / 1_000) - 86_400;
  const recent = events.filter((event) => event.timestamp >= cutoff24h);
  const firstInWindow = events.findIndex((event) => event.timestamp >= cutoff24h);
  const comparisonPrice = firstInWindow < 0 ? price : firstInWindow > 0 ? events[firstInWindow - 1].executionPrice : launchPrice;
  const tokenReserve = Number(formatUnits(tokenReserveRaw, 18));
  const chart: ChartPoint[] = [
    { time: "Launch", timestamp: token.launchedAt, price: launchPrice, volume: 0 },
    ...events.map((event) => ({
      time: `#${event.blockNumber % 100_000n}`,
      timestamp: event.timestamp,
      price: event.executionPrice,
      volume: event.usdc,
    })),
  ];
  return {
    price,
    priceChange: comparisonPrice > 0 ? (price / comparisonPrice - 1) * 100 : 0,
    marketCap,
    volume: recent.reduce((sum, event) => sum + event.usdc, 0),
    buyers: recent.filter((event) => event.type === "Buy").length,
    sellers: recent.filter((event) => event.type === "Sell").length,
    raisedUsdc: marketCap,
    targetUsdc: ARCORIGIN_CROSS_MARKET_CAP_USDC,
    progress: Math.min(100, marketCap / ARCORIGIN_CROSS_MARKET_CAP_USDC * 100),
    crossed: marketCap >= ARCORIGIN_CROSS_MARKET_CAP_USDC,
    tokensSold: Math.max(0, token.totalSupply - tokenReserve),
    tokenReserve,
    chart,
    trades: events.slice(-TRADE_FEED_LIMIT).reverse(),
    indexedBlock: finalBlock.toString(),
    generatedAt: new Date().toISOString(),
  };
}
