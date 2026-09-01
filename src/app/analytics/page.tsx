import type { Metadata } from "next";
import { ProtocolAnalytics } from "@/components/protocol-analytics";
import { DEFAULT_ANALYTICS_RANGE } from "@/lib/analytics";
import { getProtocolAnalyticsSnapshot } from "@/lib/server/protocol-analytics-snapshot";

export const metadata: Metadata = {
  title: "Protocol Analytics",
  description: "Transparent onchain analytics for ArcOrigin-native markets, fees and automatic buybacks.",
};
export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const initial = await getProtocolAnalyticsSnapshot(DEFAULT_ANALYTICS_RANGE);
  return <ProtocolAnalytics initialSnapshot={initial?.snapshot} initialStale={initial?.stale} />;
}
