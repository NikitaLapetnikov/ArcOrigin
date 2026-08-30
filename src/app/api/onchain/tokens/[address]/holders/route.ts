import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { FactoryTokenNotFoundError, getHolderSnapshot, isHolderRpcError, type HolderLaunchHint } from "@/lib/onchain/holder-snapshot";
import { snapshotCacheControl } from "@/lib/onchain/snapshot-http-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ address: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const { address } = await context.params;
  if (!isAddress(address)) return NextResponse.json({ error: "Invalid token address." }, { status: 400 });
  try {
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    const factory = request.nextUrl.searchParams.get("factory");
    const pool = request.nextUrl.searchParams.get("pool");
    const creator = request.nextUrl.searchParams.get("creator");
    const launchBlock = request.nextUrl.searchParams.get("launchBlock");
    const hint: HolderLaunchHint | undefined = factory && pool && creator && launchBlock
      && isAddress(factory) && isAddress(pool) && isAddress(creator)
      && launchBlock.length <= 16 && /^\d+$/.test(launchBlock)
      ? {
          factory: getAddress(factory),
          pool: getAddress(pool),
          creator: getAddress(creator),
          launchBlock: BigInt(launchBlock),
        }
      : undefined;
    const result = await getHolderSnapshot(getAddress(address), forceRefresh, hint);
    return NextResponse.json(result, {
      headers: {
        "Cache-Control": snapshotCacheControl({
          forceRefresh,
          stale: result.stale,
          freshPolicy: "public, max-age=30, s-maxage=60, stale-while-revalidate=600",
        }),
      },
    });
  } catch (error) {
    if (error instanceof FactoryTokenNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({
      error: isHolderRpcError(error)
        ? "Arc RPC is temporarily rate-limited. Retry in a moment."
        : "Holder data could not be loaded from confirmed Arc transfers.",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
