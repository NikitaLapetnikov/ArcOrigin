import { NextRequest, NextResponse } from "next/server";
import { getFeeSnapshot, isFeeRpcError } from "@/lib/onchain/fee-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    const result = await getFeeSnapshot(forceRefresh);
    return NextResponse.json(result, {
      headers: {
        "Cache-Control": forceRefresh ? "no-store" : "public, max-age=10, stale-while-revalidate=60",
      },
    });
  } catch (error) {
    return NextResponse.json({
      error: isFeeRpcError(error)
        ? "Arc Testnet RPC is temporarily rate-limited. Retry in a moment."
        : "Live fee data could not be loaded from Arc Testnet.",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
