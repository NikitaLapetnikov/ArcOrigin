import { NextRequest, NextResponse } from "next/server";
import { getAddress } from "viem";
import { prewarmHolderSnapshots } from "@/lib/onchain/holder-snapshot";
import { getTokenIndexSnapshot, isTokenIndexRpcError } from "@/lib/onchain/token-index-snapshot";
import { snapshotCacheControl } from "@/lib/onchain/snapshot-http-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    const result = await getTokenIndexSnapshot(forceRefresh);
    void prewarmHolderSnapshots(
      result.snapshot?.tokens.map((token) => getAddress(token.address)) ?? [],
    );
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
    return NextResponse.json({
      error: isTokenIndexRpcError(error)
        ? "Arc RPC is temporarily rate-limited. Retry in a moment."
        : "Factory launch data could not be indexed from the selected Arc network.",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
