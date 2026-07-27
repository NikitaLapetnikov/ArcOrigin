import { NextResponse } from "next/server";
import { getAddress, isAddress, maxUint256 } from "viem";
import { ARC_TESTNET_CONTRACTS } from "@/lib/chains";
import { bondingCurveAbi, factoryAbi } from "@/lib/contracts";
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

  try {
    const normalizedToken = getAddress(token);
    const normalizedCurve = getAddress(curve);
    const index = await getTokenIndexSnapshot();
    let verifiedCurve = index.snapshot?.tokens.some(
      (indexedToken) => indexedToken.address.toLowerCase() === normalizedToken.toLowerCase()
        && indexedToken.curveAddress?.toLowerCase() === normalizedCurve.toLowerCase(),
    );

    const client = createArcPublicClient(process.env.ARC_TESTNET_RPC_URL, 4_000);
    if (!verifiedCurve) {
      const tokenInfo = await client.readContract({
        address: ARC_TESTNET_CONTRACTS.factory,
        abi: factoryAbi,
        functionName: "getTokenInfo",
        args: [normalizedToken],
      });
      verifiedCurve = tokenInfo.token.toLowerCase() === normalizedToken.toLowerCase()
        && tokenInfo.curve.toLowerCase() === normalizedCurve.toLowerCase();
    }
    if (!verifiedCurve) return errorResponse("Token and curve are not a verified ArcOrigin market.", 404);

    const [output, fee] = await client.readContract({
      address: normalizedCurve,
      abi: bondingCurveAbi,
      functionName: side === "Buy" ? "quoteBuy" : "quoteSell",
      args: [amount],
    });

    return NextResponse.json(
      { input: amount.toString(), output: output.toString(), fee: fee.toString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return errorResponse("The onchain quote is temporarily unavailable.", 503);
  }
}
