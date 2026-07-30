import { NextRequest, NextResponse } from "next/server";
import { getLatestBuysSnapshot } from "@/lib/onchain/latest-buys-snapshot";
import { snapshotCacheControl } from "@/lib/onchain/snapshot-http-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    const result = await getLatestBuysSnapshot(forceRefresh);
    return NextResponse.json(result, {
      headers: {
        "Cache-Control": snapshotCacheControl({
          forceRefresh,
          stale: result.stale,
          freshPolicy: "public, max-age=5, s-maxage=15, stale-while-revalidate=300",
        }),
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Latest confirmed purchases are temporarily unavailable." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
