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

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
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

  let stage = "validate-market";
  try {
    const normalizedToken = getAddress(token);
    const normalizedCurve = getAddress(curve);
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
      const tokenInfo = await client.readContract({
        address: ARC_ACTIVE_CONTRACTS.factory,
        abi: factoryAbi,
        functionName: "getTokenInfo",
        args: [normalizedToken],
      });
      verifiedCurve = tokenInfo.token.toLowerCase() === normalizedToken.toLowerCase()
        && tokenInfo.curve.toLowerCase() === normalizedCurve.toLowerCase();
    }
    if (!verifiedCurve) return errorResponse("Token and curve are not a verified ArcOrigin market.", 404);

    if (ARCORIGIN_NETWORK === "mainnet" && ARC_UNISWAP_V3) {
      stage = "read-migration-state";
      const migrated = await client.readContract({
        address: normalizedCurve,
        abi: bondingCurveAbi,
        functionName: "isMigrated",
      });
      if (migrated) {
        stage = "verify-migrated-pool";
        const [migratedPool, canonicalPool] = await Promise.all([
          client.readContract({
            address: normalizedCurve,
            abi: bondingCurveAbi,
            functionName: "migratedPool",
          }),
          client.readContract({
            address: ARC_UNISWAP_V3.factory,
            abi: uniswapV3FactoryAbi,
            functionName: "getPool",
            args: [normalizedToken, ARC_ACTIVE_CONTRACTS.usdc, ARC_UNISWAP_V3.fee],
          }),
        ]);
        if (
          migratedPool === zeroAddress ||
          canonicalPool === zeroAddress ||
          migratedPool.toLowerCase() !== canonicalPool.toLowerCase()
        ) {
          return errorResponse("The migrated Uniswap pool could not be verified.", 409);
        }
        const tokenIn = side === "Buy" ? ARC_ACTIVE_CONTRACTS.usdc : normalizedToken;
        const tokenOut = side === "Buy" ? normalizedToken : ARC_ACTIVE_CONTRACTS.usdc;
        stage = "quote-uniswap";
        const { result } = await client.simulateContract({
          address: ARC_UNISWAP_V3.quoter,
          abi: uniswapV3QuoterAbi,
          functionName: "quoteExactInputSingle",
          args: [{
            tokenIn,
            tokenOut,
            amountIn: amount,
            fee: ARC_UNISWAP_V3.fee,
            sqrtPriceLimitX96: 0n,
          }],
        });
        const [output] = result;
        return NextResponse.json(
          {
            input: amount.toString(),
            output: output.toString(),
            fee: (amount * BigInt(ARC_UNISWAP_V3.fee) / 1_000_000n).toString(),
            venue: "uniswap-v3",
            spender: ARC_UNISWAP_V3.router,
            pool: canonicalPool,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
    }

    stage = "quote-curve";
    const [output, fee] = await client.readContract({
      address: normalizedCurve,
      abi: bondingCurveAbi,
      functionName: side === "Buy" ? "quoteBuy" : "quoteSell",
      args: [amount],
    });

    return NextResponse.json(
      {
        input: amount.toString(),
        output: output.toString(),
        fee: fee.toString(),
        venue: "curve",
        spender: normalizedCurve,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("ArcOrigin quote dependency failed.", {
      stage,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return errorResponse("The onchain quote is temporarily unavailable.", 503);
  }
}
