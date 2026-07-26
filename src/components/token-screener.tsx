"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { MarketDiscovery } from "@/components/market-discovery";
import { readWatchlist } from "@/components/watchlist-button";
import { Button, EmptyState, StatCard, WarningBox } from "@/components/ui";
import { useFactoryTokenIndex } from "@/hooks/use-factory-token-index";
import { money } from "@/lib/utils";

export function TokenScreener({ watchlistOnly = false }: { watchlistOnly?: boolean }) {
  const [query, setQuery] = useState("");
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const { tokens: indexedTokens, loading, error, refresh, isCached, isPartial, cachedAt } = useFactoryTokenIndex();
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
  const onchainVolume = availableTokens.reduce((sum, token) => sum + token.volume24h, 0);
  const raised = availableTokens.reduce((sum, token) => sum + token.raisedUSDC, 0);
  const trades = availableTokens.reduce((sum, token) => sum + token.trades, 0);

  return <div className="container-shell pb-20">
    <div className="mb-5 grid gap-3 sm:grid-cols-3">
      <StatCard label={watchlistOnly ? "Saved tokens" : "Factory launches"} value={loading && indexedTokens.length === 0 ? "—" : String(availableTokens.length)} detail={watchlistOnly ? "Stored in this browser" : isCached && cachedAt ? `Cached ${new Date(cachedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Confirmed onchain"}/>
      <StatCard label="Onchain volume" value={availableTokens.length > 0 && !isPartial ? money(onchainVolume) : "—"} detail={isPartial ? "Live market data unavailable" : loading ? "Refreshing in background" : `${trades} confirmed trades`}/>
      <StatCard label="Curve reserves" value={availableTokens.length > 0 && !isPartial ? money(raised) : "—"} detail={isPartial ? "Live market data unavailable" : loading ? "Refreshing in background" : "Confirmed onchain reserves"}/>
    </div>
    {error && <div className="mb-5 flex items-center gap-3"><div className="flex-1"><WarningBox>{error}</WarningBox></div><Button variant="ghost" onClick={() => void refresh()}>Retry live data</Button></div>}
    <label className="relative mb-4 block">
      <Search className="absolute left-4 top-1/2 size-4 -translate-y-1/2 text-slate-600" />
      <input
        type="search"
        className="input h-12 pl-11 pr-4"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search token, ticker, or contract address"
        aria-label="Search tokens"
      />
    </label>
    {!loading && watchlistOnly && availableTokens.length === 0
      ? <EmptyState title="No saved tokens yet" body="Use the star on any token page to add it here." />
      : <MarketDiscovery tokens={tokens}/>}
  </div>;
}
