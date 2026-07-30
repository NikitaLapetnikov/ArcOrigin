import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { FactoryTokenNotFoundError } from "@/lib/onchain/holder-snapshot";
import { getMarketSnapshot, isMarketRpcError } from "@/lib/onchain/market-snapshot";
import { snapshotCacheControl } from "@/lib/onchain/snapshot-http-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ address: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const { address } = await context.params;
  if (!isAddress(address)) return NextResponse.json({ error: "Invalid token address." }, { status: 400 });
  try {
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    const result = await getMarketSnapshot(getAddress(address), forceRefresh);
    return NextResponse.json(result, {
      headers: {
        "Cache-Control": snapshotCacheControl({
          forceRefresh,
          stale: result.stale,
          freshPolicy: "public, max-age=15, s-maxage=30, stale-while-revalidate=300",
        }),
      },
    });
  } catch (error) {
    if (error instanceof FactoryTokenNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    console.error("Market snapshot refresh failed.", {
      token: getAddress(address),
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json({
      error: isMarketRpcError(error)
        ? "Arc RPC is temporarily rate-limited. Retry in a moment."
        : "Market data could not be indexed from the selected Arc network.",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
