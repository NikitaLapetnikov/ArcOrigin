import { NextRequest, NextResponse } from "next/server";
import { isAnalyticsRange, type AnalyticsRange, type ProtocolAnalyticsSnapshot } from "@/lib/analytics";
import { getStoredProtocolAnalytics } from "@/lib/server/event-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RANGE_SECONDS: Record<AnalyticsRange, number> = {
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
  all: 30 * 24 * 60 * 60,
};

function previewSnapshot(range: AnalyticsRange): ProtocolAnalyticsSnapshot {
  const now = Math.floor(Date.now() / 1_000);
  const pointCount = range === "24h" ? 24 : range === "7d" ? 7 : 30;
  const step = Math.floor(RANGE_SECONDS[range] / pointCount);
  const targetVolume = { "24h": 32_170, "7d": 39_820, "30d": 42_610, all: 42_684 }[range];
  const targetTrades = { "24h": 255, "7d": 331, "30d": 382, all: 386 }[range];
  const targetLaunches = { "24h": 4, "7d": 7, "30d": 12, all: 12 }[range];
  const launchIndexes = new Set(Array.from({ length: targetLaunches }, (_, index) => (
    Math.min(pointCount - 1, Math.floor((index + 1) * pointCount / (targetLaunches + 1)))
  )));
  const weights = Array.from({ length: pointCount }, (_, index) => {
    const growth = 0.48 + index / Math.max(1, pointCount - 1) * 0.52;
    return Math.max(.1, growth * (0.78 + Math.sin(index * 1.71) * 0.18 + Math.cos(index * 0.57) * 0.08));
  });
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const series = weights.map((weight, index) => {
    const share = weight / totalWeight;
    return {
      timestamp: now - (pointCount - index - 1) * step,
      volumeUsdc: targetVolume * share,
      trades: Math.max(1, Math.round(targetTrades * share)),
      launches: launchIndexes.has(index) ? 1 : 0,
      buybackSpentUsdc: index % 7 === 4 ? 13.4 * weight : 0,
    };
  });
  const tradeDifference = targetTrades - series.reduce((sum, point) => sum + point.trades, 0);
  if (series.length > 0) series[series.length - 1].trades = Math.max(1, series[series.length - 1].trades + tradeDifference);
  const volumeUsdc = series.reduce((sum, point) => sum + point.volumeUsdc, 0);
  const trades = series.reduce((sum, point) => sum + point.trades, 0);
  const launches = series.reduce((sum, point) => sum + point.launches, 0);
  return {
    range,
    metrics: {
      volumeUsdc,
      trades,
      traders: Math.round(trades * 0.47),
      launches,
      creators: Math.max(1, launches - 1),
      automaticBuybackLaunches: Math.min(launches, Math.ceil(launches * 0.55)),
    },
    allTime: {
      volumeUsdc: 42_684.73,
      trades: 386,
      traders: 147,
      launches: 12,
      creators: 9,
      automaticBuybackLaunches: 7,
      holders: 184,
    },
    economics: {
      feeEquivalentUsdc: volumeUsdc * 0.01,
      creatorEarningsEquivalentUsdc: volumeUsdc * 0.42 * 0.007,
      protocolRevenueEquivalentUsdc: volumeUsdc * 0.003,
      buybackAllocationEquivalentUsdc: volumeUsdc * 0.58 * 0.007,
      buybackSpentUsdc: series.reduce((sum, point) => sum + point.buybackSpentUsdc, 0),
      tokensBurned: 8_214_650,
      buybackExecutions: 14,
    },
    launchModes: { standard: 5, automaticBuyback: 7 },
    series,
    markets: [
      ["0xce9c0e29f8d5904bfac3c8a79a0c9af00e6bdccb", "Origin", "ORIGIN", true, 31_842, 221, 91],
      ["0x761eeed514b017c57aac72aa9ac41c5c39356042", "Arc Signal", "SIGNAL", false, 4_792, 54, 28],
      ["0xf967bbcb689f696645b625ca0775970b8c1bb7d6", "Native Cash", "NCASH", true, 2_884, 39, 19],
      ["0x6c2133264f4949748696f882f2d2599664155d3a", "Circle Mode", "CMODE", true, 1_965, 32, 16],
      ["0xd87b86a167243608284309891c80170554332086", "Arc One", "ARC1", false, 1_202, 21, 12],
    ].map(([address, name, symbol, automaticBuyback, volume, marketTrades, traders]) => ({
      address: String(address),
      name: String(name),
      symbol: String(symbol),
      automaticBuyback: Boolean(automaticBuyback),
      volumeUsdc: Number(volume),
      trades: Number(marketTrades),
      traders: Number(traders),
    })),
    indexedBlock: "18290642",
    indexedBlockHash: `0x${"0".repeat(64)}`,
    generatedAt: new Date().toISOString(),
    preview: true,
  };
}

export async function GET(request: NextRequest) {
  const requestedRange = request.nextUrl.searchParams.get("range");
  const range: AnalyticsRange = isAnalyticsRange(requestedRange) ? requestedRange : "24h";
  const snapshot = await getStoredProtocolAnalytics(range);
  if (snapshot) {
    return NextResponse.json({ snapshot }, {
      headers: { "Cache-Control": "public, max-age=10, s-maxage=15, stale-while-revalidate=120" },
    });
  }
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json({ snapshot: previewSnapshot(range) }, {
      headers: { "Cache-Control": "no-store" },
    });
  }
  return NextResponse.json({ error: "Protocol analytics are waiting for the event indexer." }, {
    status: 503,
    headers: { "Cache-Control": "no-store" },
  });
}
