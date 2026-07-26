import { NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import { bondingCurveAbi } from "@/lib/contracts";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";

export const dynamic = "force-dynamic";

function errorResponse(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const curve = searchParams.get("curve");
  const side = searchParams.get("side");
  const rawAmount = searchParams.get("amount");

  if (!curve || !isAddress(curve)) return errorResponse("A valid curve address is required.");
  if (side !== "Buy" && side !== "Sell") return errorResponse("Side must be Buy or Sell.");
  if (!rawAmount || !/^\d+$/.test(rawAmount)) return errorResponse("Amount must be a positive integer.");

  const amount = BigInt(rawAmount);
  if (amount <= 0n) return errorResponse("Amount must be greater than zero.");

  try {
    const client = createArcPublicClient(process.env.ARC_TESTNET_RPC_URL, 4_000);
    const [output, fee] = await client.readContract({
      address: curve as Address,
      abi: bondingCurveAbi,
      functionName: side === "Buy" ? "quoteBuy" : "quoteSell",
      args: [amount],
    });

    return NextResponse.json(
      { input: amount.toString(), output: output.toString(), fee: fee.toString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Arc quote request failed.";
    return errorResponse(message, 503);
  }
}
