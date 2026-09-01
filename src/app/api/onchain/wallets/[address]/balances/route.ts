import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { getStoredWalletBalances } from "@/lib/server/event-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ address: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { address } = await context.params;
  if (!isAddress(address)) {
    return NextResponse.json({ error: "Invalid wallet address." }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const result = await getStoredWalletBalances(getAddress(address));
  if (!result) {
    return NextResponse.json({ error: "Indexed wallet balances are temporarily unavailable." }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return NextResponse.json({
    balances: result.balances.map((balance) => ({
      tokenAddress: balance.tokenAddress,
      balance: balance.balance.toString(),
    })),
    checkpoint: result.checkpoint,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}
