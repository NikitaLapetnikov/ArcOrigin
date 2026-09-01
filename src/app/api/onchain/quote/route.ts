import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, getAddress, http, isAddress, maxUint256, zeroAddress } from "viem";
import { ARC_ACTIVE_CONTRACTS, ARC_UNISWAP_V3, arcChain } from "@/lib/chains";
import { factoryAbi, uniswapV3FactoryAbi, uniswapV3QuoterAbi } from "@/lib/contracts";
import { arcOriginPoolQuoteState, quoteArcOriginExactInput } from "@/lib/onchain/arc-origin-v3-quote";
import { arcQuoteRpcUrls, createArcPublicClient } from "@/lib/onchain/arc-rpc";
import { getCachedTokenIndexSnapshot } from "@/lib/onchain/token-index-snapshot";
import { isRpcCapacityError } from "@/lib/rpc-errors";
import { getStoredFactoryLaunch, getStoredPoolQuoteState } from "@/lib/server/event-store";
import { requestClientKey } from "@/lib/server/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type QuoteSide = "Buy" | "Sell";
type QuotePayload = {
  input: string;
  output: string;
  fee: string;
  venue: "uniswap-v3";
  spender: string;
  pool: string;
  quotedAt: number;
};

const QUOTE_CACHE_TTL_MS = 7_500;
const INDEXED_QUOTE_MAX_AGE_MS = 30_000;
const MAX_QUOTE_CACHE_ENTRIES = 256;
const MAX_PENDING_QUOTES = 256;
const QUOTE_RATE_WINDOW_MS = 60_000;
const MAX_QUOTES_PER_WINDOW = 120;
const QUOTE_RPC_TIMEOUT_MS = 6_000;
const QUOTE_RPC_HEDGE_DELAY_MS = 100;
const quoteCache = new Map<string, { expiresAt: number; payload: QuotePayload }>();
const pendingQuotes = new Map<string, Promise<QuotePayload>>();
const quoteRates = new Map<string, { startedAt: number; count: number }>();
const verifiedMarkets = new Set<string>();
const quoteClients = arcQuoteRpcUrls(process.env.ARC_MAINNET_RPC_URL).map((url) => createPublicClient({
  chain: arcChain,
  transport: http(url, { retryCount: 0, timeout: QUOTE_RPC_TIMEOUT_MS }),
}));
const validationClient = createArcPublicClient(process.env.ARC_MAINNET_RPC_URL, QUOTE_RPC_TIMEOUT_MS, 0);

class QuoteRequestError extends Error {
  constructor(message: string, readonly status: number, readonly stage: string) {
    super(message);
    this.name = "QuoteRequestError";
  }
}

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withHedgedRpc<T>(operation: (client: (typeof quoteClients)[number]) => Promise<T>) {
  const primaryClient = quoteClients[0];
  if (!primaryClient) throw new Error("No Arc quote RPC is configured.");
  // Public Arc providers occasionally leave an eth_call pending until timeout.
  // A delayed second attempt against the primary is cheaper than retrying the
  // entire quote and materially lowers cold-quote tail latency. pendingQuotes
  // still guarantees a single hedge set per exact market/side/amount.
  const attempts = [...quoteClients, primaryClient];
  const hedgeController = new AbortController();
  try {
    return await Promise.any(attempts.map(async (client, index) => {
      if (index > 0) await wait(index * QUOTE_RPC_HEDGE_DELAY_MS);
      if (hedgeController.signal.aborted) throw new Error("Quote RPC hedge cancelled.");
      return operation(client);
    }));
  } finally {
    hedgeController.abort();
  }
}

function readCachedQuote(key: string) {
  const cached = quoteCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    if (cached) quoteCache.delete(key);
    return null;
  }
  return cached.payload;
}

function writeCachedQuote(key: string, payload: QuotePayload) {
  if (quoteCache.size >= MAX_QUOTE_CACHE_ENTRIES) {
    const oldestKey = quoteCache.keys().next().value;
    if (oldestKey) quoteCache.delete(oldestKey);
  }
  quoteCache.set(key, { expiresAt: Date.now() + QUOTE_CACHE_TTL_MS, payload });
}

function consumeQuoteRate(clientKey: string) {
  const now = Date.now();
  const current = quoteRates.get(clientKey);
  if (!current || now - current.startedAt >= QUOTE_RATE_WINDOW_MS) {
    quoteRates.set(clientKey, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= MAX_QUOTES_PER_WINDOW) return false;
  current.count += 1;
  if (quoteRates.size > 2_000) {
    for (const [key, rate] of quoteRates) {
      if (now - rate.startedAt >= QUOTE_RATE_WINDOW_MS) quoteRates.delete(key);
    }
  }
  return true;
}

async function readVerifiedQuote(token: `0x${string}`, pool: `0x${string}`, side: QuoteSide, amount: bigint): Promise<QuotePayload> {
  const [index, storedMarket] = await Promise.all([
    getCachedTokenIndexSnapshot(),
    getStoredFactoryLaunch(token),
  ]);
  const indexedToken = index?.tokens.find((candidate) => candidate.address.toLowerCase() === token.toLowerCase());
  const marketKey = `${token.toLowerCase()}:${pool.toLowerCase()}`;
  let canonicalPool = pool;
  const indexedPoolMatches = indexedToken?.poolAddress?.toLowerCase() === pool.toLowerCase();
  const storedPoolMatches = storedMarket?.launch.pool.toLowerCase() === pool.toLowerCase();
  if (!indexedPoolMatches && !storedPoolMatches && !verifiedMarkets.has(marketKey)) {
    const [tokenInfo, verifiedPool] = await Promise.all([
      validationClient.readContract({
        address: ARC_ACTIVE_CONTRACTS.factory,
        abi: factoryAbi,
        functionName: "getTokenInfo",
        args: [token],
      }),
      validationClient.readContract({
        address: ARC_UNISWAP_V3.factory,
        abi: uniswapV3FactoryAbi,
        functionName: "getPool",
        args: [token, ARC_ACTIVE_CONTRACTS.usdc, ARC_UNISWAP_V3.fee],
      }),
    ]);
    if (tokenInfo.token.toLowerCase() !== token.toLowerCase() || tokenInfo.pool.toLowerCase() !== pool.toLowerCase()) {
      throw new QuoteRequestError("Token pool is not a verified ArcOrigin market.", 404, "validate-pool");
    }
    canonicalPool = verifiedPool;
    if (canonicalPool === zeroAddress || canonicalPool.toLowerCase() !== pool.toLowerCase()) {
      throw new QuoteRequestError("The canonical launch pool could not be verified.", 409, "verify-pool");
    }
    verifiedMarkets.add(marketKey);
  } else {
    verifiedMarkets.add(marketKey);
  }

  if (storedPoolMatches) {
    const indexedState = await getStoredPoolQuoteState(token);
    const indexedAt = indexedState ? Date.parse(indexedState.checkpoint.generatedAt) : NaN;
    if (indexedState && Number.isFinite(indexedAt) && Date.now() - indexedAt <= INDEXED_QUOTE_MAX_AGE_MS) {
      const state = arcOriginPoolQuoteState(token, ARC_ACTIVE_CONTRACTS.usdc, indexedState.sqrtPriceX96);
      const output = quoteArcOriginExactInput(state, side, amount, ARC_UNISWAP_V3.fee);
      return {
        input: amount.toString(),
        output: output.toString(),
        fee: (amount * BigInt(ARC_UNISWAP_V3.fee) / 1_000_000n).toString(),
        venue: "uniswap-v3",
        spender: ARC_UNISWAP_V3.router,
        pool: canonicalPool,
        quotedAt: indexedAt,
      };
    }
  }

  const tokenIn = side === "Buy" ? ARC_ACTIVE_CONTRACTS.usdc : token;
  const tokenOut = side === "Buy" ? token : ARC_ACTIVE_CONTRACTS.usdc;
  const quoteResult = await withHedgedRpc((client) => client.simulateContract({
    address: ARC_UNISWAP_V3.quoter,
    abi: uniswapV3QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn: amount, fee: ARC_UNISWAP_V3.fee, sqrtPriceLimitX96: 0n }],
  }));
  return {
    input: amount.toString(),
    output: quoteResult.result[0].toString(),
    fee: (amount * BigInt(ARC_UNISWAP_V3.fee) / 1_000_000n).toString(),
    venue: "uniswap-v3",
    spender: ARC_UNISWAP_V3.router,
    pool: canonicalPool,
    quotedAt: Date.now(),
  };
}

export async function GET(request: NextRequest) {
  if (!consumeQuoteRate(requestClientKey(request))) {
    return NextResponse.json(
      { error: "Too many quote requests. Retry in a few seconds." },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "10" } },
    );
  }
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");
  const pool = searchParams.get("pool");
  const side = searchParams.get("side");
  const rawAmount = searchParams.get("amount");
  if (!token || !isAddress(token)) return errorResponse("A valid token address is required.");
  if (!pool || !isAddress(pool)) return errorResponse("A valid pool address is required.");
  if (side !== "Buy" && side !== "Sell") return errorResponse("Side must be Buy or Sell.");
  if (!rawAmount || rawAmount.length > 78 || !/^\d+$/.test(rawAmount)) return errorResponse("Amount must be a positive uint256 integer.");
  const amount = BigInt(rawAmount);
  if (amount <= 0n || amount > maxUint256) return errorResponse("Amount is outside the uint256 range.");

  const normalizedToken = getAddress(token);
  const normalizedPool = getAddress(pool);
  const key = `${normalizedToken.toLowerCase()}:${normalizedPool.toLowerCase()}:${side}:${rawAmount}`;
  const cached = readCachedQuote(key);
  if (cached) return NextResponse.json(cached, { headers: { "Cache-Control": "no-store" } });
  let pending = pendingQuotes.get(key);
  if (!pending) {
    if (pendingQuotes.size >= MAX_PENDING_QUOTES) {
      return errorResponse("The quote service is busy. Retry in a moment.", 503);
    }
    pending = readVerifiedQuote(normalizedToken, normalizedPool, side, amount);
    pendingQuotes.set(key, pending);
  }
  try {
    const payload = await pending;
    writeCachedQuote(key, payload);
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const requestError = error instanceof QuoteRequestError ? error : null;
    console.error("ArcOrigin quote dependency failed.", { stage: requestError?.stage ?? "read-quote", errorName: error instanceof Error ? error.name : "UnknownError" });
    const dependencyMessage = isRpcCapacityError(error)
      ? "Arc RPC is busy. The quote will retry automatically."
      : "The onchain quote is temporarily unavailable.";
    return errorResponse(requestError?.message ?? dependencyMessage, requestError?.status ?? 503);
  } finally {
    if (pendingQuotes.get(key) === pending) pendingQuotes.delete(key);
  }
}
