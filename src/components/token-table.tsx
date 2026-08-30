"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import { readWatchlist } from "@/components/watchlist-button";
import { TokenLabels } from "@/components/token-labels";
import { calculateMomentumScore } from "@/lib/scoring";
import type { TokenData } from "@/lib/types";
import { money, number, tickerLabel, utcDateTime } from "@/lib/utils";
import { Badge, Button, Progress, TokenIcon } from "./ui";

const filters = ["All", "Watchlist", "New", "Trending", "Near crossed", "High volume"] as const;
type Filter = typeof filters[number];
type SortKey = "created" | "price" | "priceChange24h" | "marketCap" | "volume24h" | "trades" | "holders" | "crossProgress";
type SortDirection = "asc" | "desc";
type OnchainState = "loading" | "live" | "cached" | "unavailable";

const sortOptions: { key: SortKey; label: string }[] = [
  { key: "created", label: "Created" },
  { key: "volume24h", label: "Volume" },
  { key: "marketCap", label: "Market cap" },
  { key: "price", label: "Price" },
  { key: "priceChange24h", label: "24h change" },
  { key: "trades", label: "Trades" },
  { key: "holders", label: "Holders" },
  { key: "crossProgress", label: "Crossed" },
];

function createdSortValue(token: TokenData) {
  if (token.launchedAt) return token.launchedAt;
  return 0;
}

function createdLabel(token: TokenData) {
  return utcDateTime(token.launchedAt);
}

function sortValue(token: TokenData, key: SortKey) {
  return key === "created" ? createdSortValue(token) : token[key];
}

export function TokenTable({
  tokens,
  compact = false,
  onchainState = "live",
}: {
  tokens: TokenData[];
  compact?: boolean;
  onchainState?: OnchainState;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const [sort, setSort] = useState<SortKey>("volume24h");
  const [direction, setDirection] = useState<SortDirection>("desc");
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

  const changeSort = (key: SortKey) => {
    if (key === sort) {
      setDirection((current) => current === "desc" ? "asc" : "desc");
      return;
    }
    setSort(key);
    setDirection("desc");
  };

  const shown = useMemo(() => tokens.filter((token) => {
    const normalizedQuery = query.trim().toLowerCase();
    const matchesSearch = [token.name, token.ticker, token.address, token.creator]
      .some((value) => value.toLowerCase().includes(normalizedQuery));
    if (!matchesSearch) return false;
    if (filter === "Watchlist") return watchlist.includes(token.address.toLowerCase());
    if (filter === "New") return token.ageMinutes <= 1_440;
    if (filter === "Trending") return calculateMomentumScore(token) >= 40;
    if (filter === "Near crossed") return token.crossProgress >= 75 && token.crossProgress < 100;
    if (filter === "High volume") return token.volume24h >= 10_000;
    return true;
  }).sort((left, right) => {
    const difference = sortValue(left, sort) - sortValue(right, sort);
    if (difference !== 0) return direction === "desc" ? -difference : difference;
    return left.name.localeCompare(right.name);
  }), [tokens, query, filter, sort, direction, watchlist]);

  return <div className="panel overflow-hidden">
    {!compact && <div className="border-b border-line p-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {filters.map((item) => <Button
            key={item}
            type="button"
            variant="ghost"
            onClick={() => setFilter(item)}
            className={filter === item ? "h-8 shrink-0 bg-white/[.07] px-3 text-white" : "h-8 shrink-0 px-3 text-slate-500"}
          >{item}</Button>)}
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_132px_36px] gap-2 md:flex">
          <label className="relative min-w-0">
            <Search className="absolute left-3 top-2.5 size-4 text-slate-600"/>
            <input className="input h-9 w-full pl-9 md:w-64" placeholder="Token, ticker, address…" value={query} onChange={(event) => setQuery(event.target.value)}/>
          </label>
          <label className="relative min-w-0 md:hidden">
            <ArrowUpDown className="absolute left-3 top-2.5 size-4 text-slate-600"/>
            <select className="input h-9 w-full appearance-none pl-9 pr-7" value={sort} onChange={(event) => { setSort(event.target.value as SortKey); setDirection("desc"); }}>
              {sortOptions.map((option) => <option value={option.key} key={option.key}>{option.label}</option>)}
            </select>
          </label>
          <button type="button" aria-label={`Sort ${direction === "desc" ? "ascending" : "descending"}`} onClick={() => setDirection((current) => current === "desc" ? "asc" : "desc")} className="grid size-9 place-items-center rounded-xl border border-line text-slate-400 transition hover:text-white md:hidden">
            {direction === "desc" ? <ArrowDown className="size-4"/> : <ArrowUp className="size-4"/>}
          </button>
          <p className="hidden items-center text-[11px] text-slate-600 md:flex">Click a column to sort</p>
        </div>
      </div>
    </div>}

    <div className="grid grid-cols-[minmax(0,1fr)] gap-3 p-3 md:hidden">
      {shown.map((token) => {
        const awaitingLive = onchainState === "unavailable" && token.price <= 0;
        const progressLabel = token.crossProgress > 0 && token.crossProgress < 0.01 ? "<0.01%" : `${token.crossProgress.toFixed(2)}%`;
        return <Link key={token.address} href={`/tokens/${token.address}`} className="min-w-0 rounded-xl border border-line bg-black/15 p-4 transition active:border-cyan/40">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3"><TokenIcon label={token.icon} image={token.image}/><div className="min-w-0"><p className="truncate font-semibold text-white">{token.name}</p><div className="mt-1 flex items-center gap-2"><span className="font-mono text-[10px] text-slate-500">{tickerLabel(token.ticker)}</span></div><div className="mt-2"><TokenLabels token={token} compact /></div></div></div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-4 text-xs sm:grid-cols-4">
            <MobileMetric label="Created" value={createdLabel(token)}/>
            <MobileMetric label="Market cap" value={awaitingLive ? "—" : money(token.marketCap, true)}/>
            <MobileMetric label="Volume" value={awaitingLive ? "—" : money(token.volume24h, true)}/>
            <MobileMetric label="Holders" value={token.holders === 0 ? "—" : number(token.holders)}/>
          </div>
          <div className="mt-4"><div className="mb-2 flex items-center justify-between font-mono text-[9px] text-slate-500"><span>Crossed {awaitingLive ? "—" : progressLabel}</span><span>{money(token.targetUSDC, true)}</span></div><Progress value={awaitingLive ? 0 : token.crossProgress}/></div>
          <div className="mt-4 flex items-center justify-between"><Badge tone={token.status === "Flagged" ? "bad" : token.status === "Crossed" ? "good" : "cyan"}>{token.status}</Badge><span className="text-xs font-semibold text-cyan">Open market →</span></div>
        </Link>;
      })}
      {shown.length === 0 && <div className="p-8 text-center text-sm text-slate-500">No tokens match this view.</div>}
    </div>

    <div className="hidden overflow-x-auto md:block">
      <table className={`w-full text-left text-xs [&_td]:px-3 [&_th]:px-3 ${compact ? "min-w-[940px]" : "min-w-[1280px]"}`}>
        <thead><tr className="border-b border-line bg-white/[.012] text-[10px] text-slate-500">
          <th className="px-4 py-3 font-medium">Token</th>
          {!compact && <SortableHeader label="Created" sortKey="created" activeSort={sort} direction={direction} onSort={changeSort}/>}
          <SortableHeader label="Price / 24h" sortKey="price" secondarySortKey="priceChange24h" activeSort={sort} direction={direction} onSort={changeSort}/>
          <SortableHeader label="Market cap" sortKey="marketCap" activeSort={sort} direction={direction} onSort={changeSort}/>
          <SortableHeader label="Volume" sortKey="volume24h" activeSort={sort} direction={direction} onSort={changeSort}/>
          {!compact && <SortableHeader label="Trades" sortKey="trades" activeSort={sort} direction={direction} onSort={changeSort}/>}
          {!compact && <SortableHeader label="Holders" sortKey="holders" activeSort={sort} direction={direction} onSort={changeSort}/>}
          <SortableHeader label="Crossed" sortKey="crossProgress" activeSort={sort} direction={direction} onSort={changeSort} className="w-36"/>
          <th></th>
        </tr></thead>
        <tbody>{shown.map((token) => {
          const awaitingLive = onchainState === "unavailable" && token.price <= 0;
          const progressLabel = token.crossProgress > 0 && token.crossProgress < 0.01 ? "<0.01%" : `${token.crossProgress.toFixed(2)}%`;
          return <tr key={token.address} className="border-b border-line/60 transition last:border-0 hover:bg-white/[.025]">
            <td className="px-4 py-3"><Link href={`/tokens/${token.address}`} className="flex items-center gap-3"><TokenIcon label={token.icon} image={token.image}/><div><p className="font-semibold text-white">{token.name}</p><div className="mt-1 flex items-center gap-2"><span className="font-mono text-[10px] text-slate-500">{tickerLabel(token.ticker)}</span><span className="text-[10px] text-slate-600">{token.status}</span></div><div className="mt-1.5"><TokenLabels token={token} compact /></div></div></Link></td>
            {!compact && <td className="whitespace-nowrap text-slate-400">{createdLabel(token)}</td>}
            <td>{awaitingLive ? <span className="text-slate-600">—</span> : <><p className="text-slate-200">{money(token.price)}</p><button type="button" onClick={() => changeSort("priceChange24h")} className={token.priceChange24h >= 0 ? "mt-1 text-emerald-400" : "mt-1 text-rose-400"}>Since launch {token.priceChange24h > 0 ? "+" : ""}{token.priceChange24h.toFixed(2)}%</button></>}</td>
            <td className="text-slate-300">{awaitingLive ? "—" : money(token.marketCap, true)}</td>
            <td className="text-slate-300">{awaitingLive ? "—" : money(token.volume24h, true)}</td>
            {!compact && <td className="text-slate-400">{awaitingLive ? "—" : number(token.trades)}</td>}
            {!compact && <td className="text-slate-400">{token.holders === 0 ? "—" : number(token.holders)}</td>}
            <td className="pr-5"><div className="mb-1.5 flex justify-between text-[10px] text-slate-500"><span>{awaitingLive ? "—" : progressLabel}</span><span>{money(token.targetUSDC, true)}</span></div><Progress value={awaitingLive ? 0 : token.crossProgress}/></td>
            <td className="pr-4"><Link href={`/tokens/${token.address}`} className="font-semibold text-cyan">Trade →</Link></td>
          </tr>;
        })}</tbody>
      </table>
      {shown.length === 0 && <div className="p-10 text-center text-sm text-slate-500">No tokens match this view.</div>}
    </div>
  </div>;
}

function SortableHeader({ label, sortKey, secondarySortKey, activeSort, direction, onSort, className = "" }: {
  label: string;
  sortKey: SortKey;
  secondarySortKey?: SortKey;
  activeSort: SortKey;
  direction: SortDirection;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const isActive = activeSort === sortKey || activeSort === secondarySortKey;
  const activeKey = activeSort === secondarySortKey && secondarySortKey ? secondarySortKey : sortKey;
  return <th className={`${className} font-medium`} aria-sort={isActive ? direction === "desc" ? "descending" : "ascending" : "none"}>
    <button type="button" onClick={() => onSort(activeKey)} className={isActive ? "inline-flex items-center gap-1.5 py-3 text-slate-200" : "inline-flex items-center gap-1.5 py-3 transition hover:text-slate-300"}>
      {label}{isActive ? direction === "desc" ? <ArrowDown className="size-3"/> : <ArrowUp className="size-3"/> : <ArrowUpDown className="size-3 opacity-50"/>}
    </button>
  </th>;
}

function MobileMetric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="font-mono text-[9px] uppercase tracking-wider text-slate-600">{label}</p><p className="mt-1 truncate text-slate-200">{value}</p></div>;
}
