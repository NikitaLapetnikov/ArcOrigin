import { NextResponse } from "next/server";
import { getAddress, isAddress, maxUint256, zeroAddress } from "viem";
import {
  ARC_ACTIVE_CONTRACTS,
  ARC_UNISWAP_V3,
  ARCORIGIN_NETWORK,
} from "@/lib/chains";
import {
  bondingCurveAbi,
  factoryAbi,
  uniswapV3FactoryAbi,
  uniswapV3QuoterAbi,
} from "@/lib/contracts";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import { getTokenIndexSnapshot } from "@/lib/onchain/token-index-snapshot";

export const dynamic = "force-dynamic";

type QuoteSide = "Buy" | "Sell";
type QuotePayload = {
  input: string;
  output: string;
  fee: string;
  venue: "curve" | "uniswap-v3";
  spender: string;
  pool?: string;
};

const QUOTE_CACHE_TTL_MS = 1_500;
const MAX_QUOTE_CACHE_ENTRIES = 256;
const quoteCache = new Map<string, { expiresAt: number; payload: QuotePayload }>();
const pendingQuotes = new Map<string, Promise<QuotePayload>>();

class QuoteRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly stage: string,
  ) {
    super(message);
    this.name = "QuoteRequestError";
  }
}

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withRpcRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(attempt * 200);
    }
  }
  throw lastError;
}

function readCachedQuote(key: string) {
  const cached = quoteCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    quoteCache.delete(key);
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

async function readVerifiedQuote(
  normalizedToken: `0x${string}`,
  normalizedCurve: `0x${string}`,
  side: QuoteSide,
  amount: bigint,
): Promise<QuotePayload> {
  const index = await getTokenIndexSnapshot();
  let verifiedCurve = index.snapshot?.tokens.some(
    (indexedToken) => indexedToken.address.toLowerCase() === normalizedToken.toLowerCase()
      && indexedToken.curveAddress?.toLowerCase() === normalizedCurve.toLowerCase(),
  );

  const client = createArcPublicClient(
    ARCORIGIN_NETWORK === "mainnet"
      ? process.env.ARC_MAINNET_RPC_URL
      : process.env.ARC_TESTNET_RPC_URL,
    4_000,
  );
  if (!verifiedCurve) {
    const tokenInfo = await withRpcRetry(() => client.readContract({
      address: ARC_ACTIVE_CONTRACTS.factory,
      abi: factoryAbi,
      functionName: "getTokenInfo",
      args: [normalizedToken],
    }));
    verifiedCurve = tokenInfo.token.toLowerCase() === normalizedToken.toLowerCase()
      && tokenInfo.curve.toLowerCase() === normalizedCurve.toLowerCase();
  }
  if (!verifiedCurve) {
    throw new QuoteRequestError("Token and curve are not a verified ArcOrigin market.", 404, "validate-market");
  }

  const uniswap = ARC_UNISWAP_V3;
  if (ARCORIGIN_NETWORK === "mainnet" && uniswap) {
    const migrated = await withRpcRetry(() => client.readContract({
      address: normalizedCurve,
      abi: bondingCurveAbi,
      functionName: "isMigrated",
    }));
    if (migrated) {
      const [migratedPool, canonicalPool] = await Promise.all([
        withRpcRetry(() => client.readContract({
          address: normalizedCurve,
          abi: bondingCurveAbi,
          functionName: "migratedPool",
        })),
        withRpcRetry(() => client.readContract({
          address: uniswap.factory,
          abi: uniswapV3FactoryAbi,
          functionName: "getPool",
          args: [normalizedToken, ARC_ACTIVE_CONTRACTS.usdc, uniswap.fee],
        })),
      ]);
      if (
        migratedPool === zeroAddress
        || canonicalPool === zeroAddress
        || migratedPool.toLowerCase() !== canonicalPool.toLowerCase()
      ) {
        throw new QuoteRequestError("The migrated Uniswap pool could not be verified.", 409, "verify-migrated-pool");
      }
      const tokenIn = side === "Buy" ? ARC_ACTIVE_CONTRACTS.usdc : normalizedToken;
      const tokenOut = side === "Buy" ? normalizedToken : ARC_ACTIVE_CONTRACTS.usdc;
      const { result } = await withRpcRetry(() => client.simulateContract({
        address: uniswap.quoter,
        abi: uniswapV3QuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{
          tokenIn,
          tokenOut,
          amountIn: amount,
          fee: uniswap.fee,
          sqrtPriceLimitX96: 0n,
        }],
      }));
      const [output] = result;
      return {
        input: amount.toString(),
        output: output.toString(),
        fee: (amount * BigInt(uniswap.fee) / 1_000_000n).toString(),
        venue: "uniswap-v3",
        spender: uniswap.router,
        pool: canonicalPool,
      };
    }
  }

  const [output, fee] = await withRpcRetry(() => client.readContract({
    address: normalizedCurve,
    abi: bondingCurveAbi,
    functionName: side === "Buy" ? "quoteBuy" : "quoteSell",
    args: [amount],
  }));
  return {
    input: amount.toString(),
    output: output.toString(),
    fee: fee.toString(),
    venue: "curve",
    spender: normalizedCurve,
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");
  const curve = searchParams.get("curve");
  const side = searchParams.get("side");
  const rawAmount = searchParams.get("amount");

  if (!token || !isAddress(token)) return errorResponse("A valid token address is required.");
  if (!curve || !isAddress(curve)) return errorResponse("A valid curve address is required.");
  if (side !== "Buy" && side !== "Sell") return errorResponse("Side must be Buy or Sell.");
  if (!rawAmount || rawAmount.length > 78 || !/^\d+$/.test(rawAmount)) {
    return errorResponse("Amount must be a positive uint256 integer.");
  }

  const amount = BigInt(rawAmount);
  if (amount <= 0n || amount > maxUint256) return errorResponse("Amount is outside the uint256 range.");

  const normalizedToken = getAddress(token);
  const normalizedCurve = getAddress(curve);
  const key = `${normalizedToken.toLowerCase()}:${normalizedCurve.toLowerCase()}:${side}:${rawAmount}`;
  const cached = readCachedQuote(key);
  if (cached) {
    return NextResponse.json(cached, { headers: { "Cache-Control": "no-store" } });
  }

  let pending = pendingQuotes.get(key);
  if (!pending) {
    pending = readVerifiedQuote(normalizedToken, normalizedCurve, side, amount);
    pendingQuotes.set(key, pending);
  }

  try {
    const payload = await pending;
    writeCachedQuote(key, payload);
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const requestError = error instanceof QuoteRequestError ? error : null;
    console.error("ArcOrigin quote dependency failed.", {
      stage: requestError?.stage ?? "read-onchain-quote",
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return errorResponse(
      requestError?.message ?? "The onchain quote is temporarily unavailable.",
      requestError?.status ?? 503,
    );
  } finally {
    if (pendingQuotes.get(key) === pending) pendingQuotes.delete(key);
  }
}
