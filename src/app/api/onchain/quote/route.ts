import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress, maxUint256, zeroAddress } from "viem";
import { ARC_ACTIVE_CONTRACTS, ARC_UNISWAP_V3 } from "@/lib/chains";
import { factoryAbi, uniswapV3FactoryAbi, uniswapV3QuoterAbi } from "@/lib/contracts";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import { getTokenIndexSnapshot } from "@/lib/onchain/token-index-snapshot";
import { isRetryableRpcError, isRpcCapacityError } from "@/lib/rpc-errors";
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
};

const QUOTE_CACHE_TTL_MS = 1_500;
const MAX_QUOTE_CACHE_ENTRIES = 256;
const MAX_PENDING_QUOTES = 256;
const QUOTE_RATE_WINDOW_MS = 60_000;
const MAX_QUOTES_PER_WINDOW = 120;
const quoteCache = new Map<string, { expiresAt: number; payload: QuotePayload }>();
const pendingQuotes = new Map<string, Promise<QuotePayload>>();
const quoteRates = new Map<string, { startedAt: number; count: number }>();

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

async function withRpcRetry<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt === attempts) throw error;
      await wait(attempt * 400);
    }
  }
  throw lastError;
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
  const index = await getTokenIndexSnapshot();
  const indexedToken = index.snapshot?.tokens.find((candidate) => candidate.address.toLowerCase() === token.toLowerCase());
  const client = createArcPublicClient(
    process.env.ARC_MAINNET_RPC_URL,
    4_000,
  );
  if (indexedToken?.poolAddress?.toLowerCase() !== pool.toLowerCase()) {
    const tokenInfo = await withRpcRetry(() => client.readContract({
      address: ARC_ACTIVE_CONTRACTS.factory,
      abi: factoryAbi,
      functionName: "getTokenInfo",
      args: [token],
    }));
    if (tokenInfo.token.toLowerCase() !== token.toLowerCase() || tokenInfo.pool.toLowerCase() !== pool.toLowerCase()) {
      throw new QuoteRequestError("Token pool is not a verified ArcOrigin market.", 404, "validate-pool");
    }
  }

  const canonicalPool = await withRpcRetry(() => client.readContract({
    address: ARC_UNISWAP_V3.factory,
    abi: uniswapV3FactoryAbi,
    functionName: "getPool",
    args: [token, ARC_ACTIVE_CONTRACTS.usdc, ARC_UNISWAP_V3.fee],
  }));
  if (canonicalPool === zeroAddress || canonicalPool.toLowerCase() !== pool.toLowerCase()) {
    throw new QuoteRequestError("The canonical launch pool could not be verified.", 409, "verify-pool");
  }
  const tokenIn = side === "Buy" ? ARC_ACTIVE_CONTRACTS.usdc : token;
  const tokenOut = side === "Buy" ? token : ARC_ACTIVE_CONTRACTS.usdc;
  const { result } = await withRpcRetry(() => client.simulateContract({
    address: ARC_UNISWAP_V3.quoter,
    abi: uniswapV3QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn: amount, fee: ARC_UNISWAP_V3.fee, sqrtPriceLimitX96: 0n }],
  }));
  return {
    input: amount.toString(),
    output: result[0].toString(),
    fee: (amount * BigInt(ARC_UNISWAP_V3.fee) / 1_000_000n).toString(),
    venue: "uniswap-v3",
    spender: ARC_UNISWAP_V3.router,
    pool: canonicalPool,
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
