export const ANALYTICS_RANGES = ["24h", "7d", "30d", "all"] as const;

export type AnalyticsRange = typeof ANALYTICS_RANGES[number];

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
