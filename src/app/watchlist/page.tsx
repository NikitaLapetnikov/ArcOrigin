import type { Metadata } from "next";
import { TokenScreener } from "@/components/token-screener";
import { PageIntro } from "@/components/ui";

export const metadata: Metadata = { title: "Watchlist" };

export default function WatchlistPage() {
  return <>
    <PageIntro compact eyebrow="Watchlist" title="Saved tokens" body="Your saved markets." />
    <TokenScreener watchlistOnly />
  </>;
}
