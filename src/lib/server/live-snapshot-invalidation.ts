import "server-only";

import type { LiveIndexerEvent } from "@/lib/indexer/live-event";
import { invalidateBuybackSnapshot } from "@/lib/onchain/buyback-snapshot";
import { invalidateHolderSnapshot } from "@/lib/onchain/holder-snapshot";
import { invalidateLatestBuysSnapshot } from "@/lib/onchain/latest-buys-snapshot";
import { invalidateMarketSnapshot } from "@/lib/onchain/market-snapshot";
import { invalidateTokenIndexSnapshot } from "@/lib/onchain/token-index-snapshot";

export function invalidateSnapshotsForLiveEvent(event: LiveIndexerEvent) {
  if (event.kind === "launch") {
    invalidateTokenIndexSnapshot();
    return;
  }
  if (event.kind === "swap") {
    invalidateMarketSnapshot(event.tokenAddress);
    invalidateLatestBuysSnapshot();
    return;
  }
  if (event.kind === "holder_change") {
    invalidateHolderSnapshot(event.tokenAddress);
    return;
  }
  if (event.kind === "buyback") {
    invalidateBuybackSnapshot(event.tokenAddress);
  }
}
