import { NextResponse } from "next/server";
import {
  ARC_ACTIVE_FACTORY,
  ARC_ACTIVE_FACTORY_BLOCK,
  ARC_OFFICIAL_ORIGIN_TOKEN,
  arcChain,
  isOfficialOriginToken,
} from "@/lib/chains";
import { getTokenIndexSnapshot, isTokenIndexRpcError } from "@/lib/onchain/token-index-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PLATFORM_URL = "https://arcorigin.xyz/";
const PLATFORM_LOGO_URL = "https://arcorigin.xyz/brand/arcorigin-logo-v2.png";

export async function GET() {
  try {
    const result = await getTokenIndexSnapshot();
    const snapshot = result.snapshot;
    const tokens = (snapshot?.tokens ?? []).map((token) => {
      const official = isOfficialOriginToken(token.address);
      const automaticBuyback = token.automaticBuyback === true;
      return {
        address: token.address,
        name: token.name,
        symbol: token.ticker,
        decimals: 18,
        image: token.image ?? null,
        logoURI: token.image ?? null,
        website: token.socials.website ?? null,
        twitter: token.socials.x ?? null,
        x: token.socials.x ?? null,
        telegram: token.socials.telegram ?? null,
        description: token.description,
        creator: token.creator,
        pool: token.poolAddress ?? null,
        metadataURI: token.metadataURI ?? null,
        launchedAt: token.launchedAt ?? null,
        launchBlock: token.launchBlock ?? null,
        automaticBuyback,
        official,
        verified: official,
        labels: [
          ...(official ? ["Official"] : []),
          ...(automaticBuyback ? ["Auto Buyback"] : []),
        ],
      };
    });

    return NextResponse.json({
      name: "ArcOrigin",
      chainId: arcChain.id,
      network: arcChain.name,
      website: PLATFORM_URL,
      logoURI: PLATFORM_LOGO_URL,
      factoryAddresses: [ARC_ACTIVE_FACTORY],
      factoryFromBlock: ARC_ACTIVE_FACTORY_BLOCK.toString(),
      officialToken: ARC_OFFICIAL_ORIGIN_TOKEN,
      timestamp: snapshot?.generatedAt ?? new Date().toISOString(),
      stale: result.stale,
      tokens,
    }, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=600",
      },
    });
  } catch (error) {
    return NextResponse.json({
      error: isTokenIndexRpcError(error)
        ? "Arc RPC is temporarily rate-limited."
        : "ArcOrigin token data is temporarily unavailable.",
    }, {
      status: 503,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  }
}
