export const ANALYTICS_RANGES = ["24h", "7d", "30d", "all"] as const;

export type AnalyticsRange = typeof ANALYTICS_RANGES[number];

export const DEFAULT_ANALYTICS_RANGE: AnalyticsRange = "all";

export type AnalyticsSeriesPoint = {
  timestamp: number;
  volumeUsdc: number;
  trades: number;
  launches: number;
  buybackSpentUsdc: number;
};

export type AnalyticsMarket = {
  address: string;
  name: string;
  symbol: string;
  automaticBuyback: boolean;
  volumeUsdc: number;
  trades: number;
  traders: number;
};

export type AnalyticsWindowMetrics = {
  volumeUsdc: number;
  trades: number;
  traders: number;
  launches: number;
  creators: number;
  automaticBuybackLaunches: number;
};

export type ProtocolAnalyticsSnapshot = {
  schemaVersion: 1;
  range: AnalyticsRange;
  metrics: AnalyticsWindowMetrics;
  allTime: AnalyticsWindowMetrics & {
    holders: number;
  };
  economics: {
    feeEquivalentUsdc: number;
    creatorEarningsEquivalentUsdc: number;
    protocolRevenueEquivalentUsdc: number;
    buybackAllocationEquivalentUsdc: number;
    buybackSpentUsdc: number;
    tokensBurned: number;
    buybackExecutions: number;
  };
  launchModes: {
    standard: number;
    automaticBuyback: number;
  };
  series: AnalyticsSeriesPoint[];
  markets: AnalyticsMarket[];
  indexedBlock: string;
  indexedBlockHash: string;
  generatedAt: string;
  preview?: boolean;
};

export function isAnalyticsRange(value: string | null): value is AnalyticsRange {
  return ANALYTICS_RANGES.includes(value as AnalyticsRange);
}

function finiteNonNegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validWindowMetrics(value: unknown): value is AnalyticsWindowMetrics {
  if (!value || typeof value !== "object") return false;
  const metrics = value as Partial<AnalyticsWindowMetrics>;
  return finiteNonNegative(metrics.volumeUsdc)
    && finiteNonNegative(metrics.trades)
    && finiteNonNegative(metrics.traders)
    && finiteNonNegative(metrics.launches)
    && finiteNonNegative(metrics.creators)
    && finiteNonNegative(metrics.automaticBuybackLaunches);
}

export function isProtocolAnalyticsSnapshot(value: unknown): value is ProtocolAnalyticsSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<ProtocolAnalyticsSnapshot>;
  const allTime = snapshot.allTime;
  const economics = snapshot.economics;
  const launchModes = snapshot.launchModes;
  return snapshot.schemaVersion === 1
    && isAnalyticsRange(snapshot.range ?? null)
    && validWindowMetrics(snapshot.metrics)
    && validWindowMetrics(allTime)
    && finiteNonNegative(allTime?.holders)
    && Boolean(economics
      && finiteNonNegative(economics.feeEquivalentUsdc)
      && finiteNonNegative(economics.creatorEarningsEquivalentUsdc)
      && finiteNonNegative(economics.protocolRevenueEquivalentUsdc)
      && finiteNonNegative(economics.buybackAllocationEquivalentUsdc)
      && finiteNonNegative(economics.buybackSpentUsdc)
      && finiteNonNegative(economics.tokensBurned)
      && finiteNonNegative(economics.buybackExecutions))
    && Boolean(launchModes
      && finiteNonNegative(launchModes.standard)
      && finiteNonNegative(launchModes.automaticBuyback))
    && Array.isArray(snapshot.series)
    && snapshot.series.every((point) => finiteNonNegative(point.timestamp)
      && finiteNonNegative(point.volumeUsdc)
      && finiteNonNegative(point.trades)
      && finiteNonNegative(point.launches)
      && finiteNonNegative(point.buybackSpentUsdc))
    && Array.isArray(snapshot.markets)
    && snapshot.markets.every((market) => typeof market.address === "string"
      && /^0x[0-9a-fA-F]{40}$/.test(market.address)
      && typeof market.name === "string"
      && typeof market.symbol === "string"
      && typeof market.automaticBuyback === "boolean"
      && finiteNonNegative(market.volumeUsdc)
      && finiteNonNegative(market.trades)
      && finiteNonNegative(market.traders))
    && typeof snapshot.indexedBlock === "string"
    && /^\d+$/.test(snapshot.indexedBlock)
    && typeof snapshot.indexedBlockHash === "string"
    && /^0x[0-9a-fA-F]{64}$/.test(snapshot.indexedBlockHash)
    && typeof snapshot.generatedAt === "string"
    && Number.isFinite(Date.parse(snapshot.generatedAt));
}
