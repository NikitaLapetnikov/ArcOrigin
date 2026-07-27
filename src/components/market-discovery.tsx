"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, ChevronLeft, ChevronRight } from "lucide-react";
import { readWatchlist } from "@/components/watchlist-button";
import { calculateMomentumScore } from "@/lib/scoring";
import type { TokenData, Trade } from "@/lib/types";
import { money, number, utcDateTime } from "@/lib/utils";
import { Badge, TokenIcon } from "@/components/ui";

type DiscoveryTab = "buys" | "new" | "old" | "trending" | "graduated" | "marketCap" | "volume" | "watchlist";

const tabs: { id: DiscoveryTab; label: string }[] = [
  { id: "buys", label: "Latest buys" },
  { id: "new", label: "New" },
  { id: "old", label: "Old" },
  { id: "trending", label: "Trending" },
  { id: "graduated", label: "Graduated" },
  { id: "marketCap", label: "Market cap" },
  { id: "volume", label: "Volume" },
  { id: "watchlist", label: "Watchlist" },
];

type BuyItem = { token: TokenData; trade: Trade; order: number };
const PAGE_SIZE = 20;

function launchOrder(token: TokenData) {
  if (token.launchedAt) return token.launchedAt;
  return 0;
}

function launchTime(token: TokenData) {
  return utcDateTime(token.launchedAt);
}

function tradeOrder(token: TokenData, trade: Trade, index: number) {
  if (trade.timestamp) return trade.timestamp;
  return (token.launchedAt ?? 0) - index;
}

export function MarketDiscovery({ tokens }: { tokens: TokenData[] }) {
  const [activeTab, setActiveTab] = useState<DiscoveryTab>("new");
  const [page, setPage] = useState(1);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  useEffect(() => {
    const sync = () => setWatchlist(readWatchlist());
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("arcorigin:watchlist-updated", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("arcorigin:watchlist-updated", sync);
    };
  }, []);
  const latestBuys = useMemo(() => tokens.flatMap((token) => token.recentTrades
    .filter((trade) => trade.type === "Buy")
    .map((trade, index): BuyItem => ({
      token,
      trade,
      order: tradeOrder(token, trade, index),
    })))
    .sort((left, right) => right.order - left.order), [tokens]);
  const newLaunches = useMemo(() => [...tokens].sort((left, right) => launchOrder(right) - launchOrder(left)), [tokens]);
  const oldLaunches = useMemo(() => [...tokens].sort((left, right) => launchOrder(left) - launchOrder(right)), [tokens]);
  const trending = useMemo(() => tokens.map((token) => ({ token, score: calculateMomentumScore(token) }))
    .sort((left, right) => right.score - left.score)
    .map(({ token }) => token), [tokens]);
  const graduated = useMemo(() => tokens.filter((token) => token.status === "Graduated")
    .sort((left, right) => right.volume24h - left.volume24h), [tokens]);
  const byMarketCap = useMemo(() => [...tokens].sort((left, right) => right.marketCap - left.marketCap), [tokens]);
  const byVolume = useMemo(() => [...tokens].sort((left, right) => right.volume24h - left.volume24h), [tokens]);
  const watchedTokens = useMemo(
    () => tokens.filter((token) => watchlist.includes(token.address.toLowerCase())),
    [tokens, watchlist],
  );
  const activeTokens = activeTab === "new"
    ? newLaunches
    : activeTab === "old"
      ? oldLaunches
      : activeTab === "trending"
        ? trending
        : activeTab === "graduated"
          ? graduated
          : activeTab === "marketCap"
            ? byMarketCap
            : activeTab === "volume"
              ? byVolume
              : activeTab === "watchlist"
                ? watchedTokens
              : [];
  const totalItems = activeTab === "buys" ? latestBuys.length : activeTokens.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const pageStart = (page - 1) * PAGE_SIZE;
  const visibleBuys = latestBuys.slice(pageStart, pageStart + PAGE_SIZE);
  const visibleTokens = activeTokens.slice(pageStart, pageStart + PAGE_SIZE);

  useEffect(() => {
    setPage(1);
  }, [activeTab, tokens]);

  return <section className="panel mb-5 overflow-hidden" aria-label="Market activity">
    <div className="flex items-center gap-1 overflow-x-auto border-b border-line px-3 py-2.5" role="tablist" aria-label="Market discovery">
      {tabs.map(({ id, label }) => <button
        key={id}
        type="button"
        role="tab"
        aria-selected={activeTab === id}
        aria-controls={`market-panel-${id}`}
        onClick={() => setActiveTab(id)}
        className={activeTab === id
          ? "inline-flex h-10 shrink-0 items-center rounded-lg border border-cyan/35 bg-white/[.08] px-4 text-[15px] font-semibold text-white shadow-[0_0_0_1px_rgba(57,189,248,.08)]"
          : "inline-flex h-10 shrink-0 items-center rounded-lg border border-transparent px-4 text-[15px] font-semibold text-slate-400 transition hover:bg-white/[.035] hover:text-white"}
      >{label}</button>)}
      <p className="ml-auto hidden pr-3 text-xs text-slate-500 2xl:block">{tokens.length} token{tokens.length === 1 ? "" : "s"}</p>
    </div>

    <div id={`market-panel-${activeTab}`} role="tabpanel" className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-5">
      {activeTab === "buys" && visibleBuys.map(({ token, trade }, index) => <Link
        href={`/tokens/${token.address}`}
        key={`${token.address}-${trade.txHash}-${index}`}
        className="group min-w-0 rounded-xl border border-line bg-black/15 p-3 transition hover:-translate-y-0.5 hover:border-cyan/25 hover:bg-white/[.025]"
      >
        <TokenIcon label={token.icon} image={token.image} className="aspect-square size-auto w-full rounded-xl text-3xl" />
        <div className="mt-3 flex items-start justify-between gap-3">
          <div className="min-w-0"><p className="truncate text-sm font-semibold text-white">{token.name}</p><p className="mt-1 font-mono text-[10px] text-slate-500">{token.ticker}</p></div>
          <Badge tone="good">Buy</Badge>
        </div>
        <div className="mt-4 flex items-end justify-between gap-3 border-t border-line/70 pt-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-emerald-300">+{number(trade.tokens)} {token.ticker}</p><p className="mt-1 text-xs text-slate-500">for {money(trade.usdc)}</p></div><p className="shrink-0 text-[10px] text-slate-500">{utcDateTime(trade.timestamp)}</p></div>
      </Link>)}

      {activeTab !== "buys" && visibleTokens.map((token, index) => <TokenMarketCard
        key={token.address}
        token={token}
        rank={activeTab === "trending" || activeTab === "marketCap" || activeTab === "volume" ? pageStart + index + 1 : undefined}
      />)}

      {activeTab === "buys" && visibleBuys.length === 0 && <EmptyActivity message="No confirmed buys yet. The feed will update after the first onchain trade."/>}
      {activeTab !== "buys" && activeTokens.length === 0 && <EmptyActivity message={activeTab === "graduated"
        ? "No tokens have graduated yet."
        : activeTab === "watchlist"
          ? "No saved tokens yet. Use the star on a token page to add it here."
        : "No tokens match this view or search."}/>}
    </div>
    {totalItems > 0 && <Pagination page={page} totalPages={totalPages} onPage={setPage} />}
  </section>;
}

function TokenMarketCard({ token, rank }: { token: TokenData; rank?: number }) {
  return <Link
    href={`/tokens/${token.address}`}
    className="group min-w-0 rounded-xl border border-line bg-black/15 p-3 transition hover:-translate-y-0.5 hover:border-cyan/25 hover:bg-white/[.025]"
  >
    <div className="relative">
      <TokenIcon label={token.icon} image={token.image} className="aspect-square size-auto w-full rounded-xl text-3xl"/>
      {rank && <span className="absolute left-2 top-2 rounded-lg border border-white/10 bg-black/70 px-2 py-1 font-mono text-[10px] text-slate-200 backdrop-blur-md">#{rank}</span>}
    </div>
    <div className="mt-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-white">{token.name}</p>
        <p className="mt-1 font-mono text-[10px] text-slate-500">{token.ticker}</p>
      </div>
      <ArrowUpRight className="size-4 shrink-0 text-slate-600 transition group-hover:text-cyan"/>
    </div>
    <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line/70 pt-3">
      <CardMetric label="Market cap" value={money(token.marketCap, true)} />
      <CardMetric label="Volume" value={money(token.volume24h, true)} />
    </div>
    <p className="mt-3 truncate text-[10px] text-slate-600">{launchTime(token)}</p>
  </Link>;
}

function CardMetric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="truncate text-[8px] font-medium uppercase tracking-[.07em] text-slate-600">{label}</p><p className="mt-1 truncate text-[11px] font-medium text-slate-200">{value}</p></div>;
}

function EmptyActivity({ message }: { message: string }) {
  return <div className="col-span-full flex min-h-32 items-center justify-center rounded-xl border border-dashed border-line px-5 text-center text-sm text-slate-500">{message}</div>;
}

function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (page: number) => void }) {
  const pages = Array.from({ length: totalPages }, (_, index) => index + 1)
    .filter((item) => item === 1 || item === totalPages || Math.abs(item - page) <= 1);

  return <nav aria-label="Token pages" className="flex items-center justify-center gap-1 border-t border-line px-4 py-5">
    <button type="button" aria-label="Previous page" disabled={page === 1} onClick={() => onPage(page - 1)} className="grid size-9 place-items-center rounded-lg border border-line text-slate-400 transition hover:border-cyan/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"><ChevronLeft className="size-4"/></button>
    {pages.map((item, index) => {
      const previous = pages[index - 1];
      return <span key={item} className="contents">
        {previous && item - previous > 1 && <span className="px-2 text-sm text-slate-600">…</span>}
        <button type="button" aria-current={item === page ? "page" : undefined} onClick={() => onPage(item)} className={item === page ? "grid size-9 place-items-center rounded-lg bg-cyan text-sm font-semibold text-ink" : "grid size-9 place-items-center rounded-lg text-sm text-slate-400 transition hover:bg-white/[.04] hover:text-white"}>{item}</button>
      </span>;
    })}
    <button type="button" aria-label="Next page" disabled={page === totalPages} onClick={() => onPage(page + 1)} className="grid size-9 place-items-center rounded-lg border border-line text-slate-400 transition hover:border-cyan/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"><ChevronRight className="size-4"/></button>
  </nav>;
}
