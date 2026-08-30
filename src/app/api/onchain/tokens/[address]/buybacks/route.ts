import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { getBuybackSnapshot } from "@/lib/onchain/buyback-snapshot";
import { FactoryTokenNotFoundError } from "@/lib/onchain/holder-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ address: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const { address } = await context.params;
  if (!isAddress(address)) return NextResponse.json({ error: "Invalid token address." }, { status: 400 });
  try {
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    const snapshot = await getBuybackSnapshot(getAddress(address), forceRefresh);
    return NextResponse.json({ snapshot }, {
      headers: { "Cache-Control": forceRefresh ? "no-store" : "public, max-age=10, s-maxage=20, stale-while-revalidate=120" },
    });
  } catch (error) {
    if (error instanceof FactoryTokenNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    console.error("Buyback snapshot refresh failed.", {
      token: getAddress(address),
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return NextResponse.json({ error: "Buyback data is temporarily unavailable." }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
