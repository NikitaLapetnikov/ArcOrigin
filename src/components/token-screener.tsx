"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { LatestBuys, LatestBuysLoading, MarketDiscovery } from "@/components/market-discovery";
import { readWatchlist } from "@/components/watchlist-button";
import { Button, EmptyState, WarningBox } from "@/components/ui";
import { useFactoryTokenIndex } from "@/hooks/use-factory-token-index";
import { useLatestBuys } from "@/hooks/use-latest-buys";

export function TokenScreener({ watchlistOnly = false }: { watchlistOnly?: boolean }) {
  const [query, setQuery] = useState("");
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const { tokens: indexedTokens, loading, error, refresh, marketDataReady } = useFactoryTokenIndex();
  const latestBuys = useLatestBuys();
  useEffect(() => {
    if (!watchlistOnly) return;
    const sync = () => setWatchlist(readWatchlist());
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("arcorigin:watchlist-updated", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("arcorigin:watchlist-updated", sync);
    };
  }, [watchlistOnly]);

  const availableTokens = useMemo(
    () => watchlistOnly
      ? indexedTokens.filter((token) => watchlist.includes(token.address.toLowerCase()))
      : indexedTokens,
    [indexedTokens, watchlist, watchlistOnly],
  );
  const tokens = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return availableTokens;
    return availableTokens.filter((token) => [token.name, token.ticker, token.address]
      .some((value) => value.toLowerCase().includes(normalized)));
  }, [availableTokens, query]);

  return <div className="container-shell pb-20">
    <label className="relative mb-4 block">
      <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
      <input
        type="search"
        className="input h-[52px] rounded-xl pl-11 pr-4 text-[15px]"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search token, ticker, or contract address"
        aria-label="Search tokens"
      />
    </label>
    {error && <div className="mb-4 flex items-center gap-3"><div className="flex-1"><WarningBox>{error}</WarningBox></div><Button variant="ghost" onClick={() => void refresh()}>Retry live data</Button></div>}
    {!loading && watchlistOnly && availableTokens.length === 0
      ? <EmptyState title="No saved tokens yet" body="Use the star on any token page to add it here." />
      : <>
        {!watchlistOnly && (latestBuys.ready || marketDataReady
          ? <LatestBuys tokens={tokens} records={latestBuys.ready ? latestBuys.buys : undefined} limit={10} />
          : latestBuys.loading || loading
            ? <LatestBuysLoading />
            : null)}
        <MarketDiscovery tokens={tokens}/>
      </>}
  </div>;
}
