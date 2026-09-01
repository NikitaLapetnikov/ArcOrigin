import type { Metadata } from "next";
import { ProtocolAnalytics } from "@/components/protocol-analytics";
import { getStoredProtocolAnalytics } from "@/lib/server/event-store";

export const metadata: Metadata = {
  title: "Protocol Analytics",
  description: "Transparent onchain analytics for ArcOrigin-native markets, fees and automatic buybacks.",
};
export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const initialSnapshot = await getStoredProtocolAnalytics("24h");
  return <ProtocolAnalytics initialSnapshot={initialSnapshot} />;
}
