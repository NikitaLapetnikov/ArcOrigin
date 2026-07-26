import { NextRequest, NextResponse } from "next/server";
import { getTokenIndexSnapshot, isTokenIndexRpcError } from "@/lib/onchain/token-index-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    const result = await getTokenIndexSnapshot(forceRefresh);
    return NextResponse.json(result, {
      headers: { "Cache-Control": forceRefresh ? "no-store" : "public, max-age=15, s-maxage=30, stale-while-revalidate=300" },
    });
  } catch (error) {
    return NextResponse.json({
      error: isTokenIndexRpcError(error)
        ? "Arc Testnet RPC is temporarily rate-limited. Retry in a moment."
        : "Factory launch data could not be indexed from Arc Testnet.",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
