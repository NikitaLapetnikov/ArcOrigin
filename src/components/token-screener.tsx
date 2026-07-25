"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { MarketDiscovery } from "@/components/market-discovery";
import { Button, StatCard, WarningBox } from "@/components/ui";
import { useFactoryTokenIndex } from "@/hooks/use-factory-token-index";
import { money } from "@/lib/utils";

export function TokenScreener() {
  const [query, setQuery] = useState("");
  const { tokens: indexedTokens, loading, error, refresh, isCached, isPartial, cachedAt } = useFactoryTokenIndex();
  const tokens = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return indexedTokens;
    return indexedTokens.filter((token) => [token.name, token.ticker, token.address]
      .some((value) => value.toLowerCase().includes(normalized)));
  }, [indexedTokens, query]);
  const onchainVolume = indexedTokens.reduce((sum, token) => sum + token.volume24h, 0);
  const raised = indexedTokens.reduce((sum, token) => sum + token.raisedUSDC, 0);
  const trades = indexedTokens.reduce((sum, token) => sum + token.trades, 0);

  return <div className="container-shell pb-20">
    <div className="mb-5 grid gap-3 sm:grid-cols-3">
      <StatCard label="Factory launches" value={loading && indexedTokens.length === 0 ? "—" : String(indexedTokens.length)} detail={isCached && cachedAt ? `Cached ${new Date(cachedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Confirmed onchain"}/>
      <StatCard label="Onchain volume" value={indexedTokens.length > 0 && !isPartial ? money(onchainVolume) : "—"} detail={isPartial ? "Live market data unavailable" : loading ? "Refreshing in background" : `${trades} confirmed trades`}/>
      <StatCard label="Curve reserves" value={indexedTokens.length > 0 && !isPartial ? money(raised) : "—"} detail={isPartial ? "Live market data unavailable" : loading ? "Refreshing in background" : "Confirmed onchain reserves"}/>
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
    <MarketDiscovery tokens={tokens}/>
  </div>;
}
