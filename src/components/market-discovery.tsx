"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Activity, ArrowUpRight, Flame, Rocket } from "lucide-react";
import { calculateMomentumScore } from "@/lib/scoring";
import type { TokenData, Trade } from "@/lib/types";
import { money, number, utcDateTime } from "@/lib/utils";
import { Progress, TokenIcon } from "@/components/ui";

type DiscoveryTab = "buys" | "launches" | "trending";

const tabs: { id: DiscoveryTab; label: string; icon: typeof Activity }[] = [
  { id: "buys", label: "Latest buys", icon: Activity },
  { id: "launches", label: "New launches", icon: Rocket },
  { id: "trending", label: "Trending", icon: Flame },
];

type BuyItem = { token: TokenData; trade: Trade; order: number };

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
  const [activeTab, setActiveTab] = useState<DiscoveryTab>("buys");
  const latestBuys = useMemo(() => tokens.flatMap((token) => token.recentTrades
    .filter((trade) => trade.type === "Buy")
    .map((trade, index): BuyItem => ({
      token,
      trade,
      order: tradeOrder(token, trade, index),
    })))
    .sort((left, right) => right.order - left.order)
    .slice(0, 8), [tokens]);
  const newLaunches = useMemo(() => [...tokens].sort((left, right) => launchOrder(right) - launchOrder(left)).slice(0, 8), [tokens]);
  const trending = useMemo(() => tokens.map((token) => ({ token, score: calculateMomentumScore(token) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 8), [tokens]);

  return <section className="panel mb-5 overflow-hidden" aria-label="Market activity">
    <div className="flex items-center gap-1 overflow-x-auto border-b border-line p-2" role="tablist" aria-label="Market discovery">
      {tabs.map(({ id, label, icon: Icon }) => <button
        key={id}
        type="button"
        role="tab"
        aria-selected={activeTab === id}
        aria-controls={`market-panel-${id}`}
        onClick={() => setActiveTab(id)}
        className={activeTab === id
          ? "inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-white/[.07] px-3 text-xs font-semibold text-white"
          : "inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-xs font-medium text-slate-500 transition hover:text-slate-300"}
      ><Icon className="size-3.5"/>{label}</button>)}
      <p className="ml-auto hidden pr-3 text-[11px] text-slate-600 lg:block">Factory-verified Arc Testnet activity only</p>
    </div>

    <div id={`market-panel-${activeTab}`} role="tabpanel" className="grid auto-cols-[minmax(250px,1fr)] grid-flow-col gap-3 overflow-x-auto p-3 lg:grid-flow-row lg:grid-cols-4">
      {activeTab === "buys" && latestBuys.map(({ token, trade }, index) => <Link
        href={`/tokens/${token.address}`}
        key={`${token.address}-${trade.txHash}-${index}`}
        className="group rounded-xl border border-line bg-black/15 p-4 transition hover:border-cyan/25 hover:bg-white/[.025]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3"><TokenIcon label={token.icon} image={token.image}/><div className="min-w-0"><p className="truncate text-sm font-semibold text-white">{token.name}</p><p className="mt-1 font-mono text-[10px] text-slate-500">{token.ticker}</p></div></div>
        </div>
        <div className="mt-5 flex items-end justify-between gap-4"><div><p className="text-lg font-semibold text-emerald-300">+{number(trade.tokens)} {token.ticker}</p><p className="mt-1 text-xs text-slate-500">for {money(trade.usdc)}</p></div><div className="text-right"><p className="text-[10px] uppercase tracking-wider text-slate-600">Buy</p><p className="mt-1 text-[11px] text-slate-500">{utcDateTime(trade.timestamp)}</p></div></div>
      </Link>)}

      {activeTab === "launches" && newLaunches.map((token) => <Link
        href={`/tokens/${token.address}`}
        key={token.address}
        className="group rounded-xl border border-line bg-black/15 p-4 transition hover:border-cyan/25 hover:bg-white/[.025]"
      >
        <div className="flex items-start justify-between gap-3"><TokenIcon label={token.icon} image={token.image} className="size-12"/><span className="max-w-36 text-right text-[11px] leading-4 text-slate-500">{launchTime(token)}</span></div>
        <div className="mt-4"><div className="min-w-0"><p className="truncate font-semibold text-white">{token.name}</p><p className="mt-1 font-mono text-[10px] text-slate-500">{token.ticker}</p></div></div>
        <div className="mt-4 flex items-center justify-between border-t border-line/70 pt-3 text-xs"><span className="text-slate-500">Market cap</span><span className="font-medium text-slate-200">{money(token.marketCap, true)}</span></div>
      </Link>)}

      {activeTab === "trending" && trending.map(({ token, score }, index) => <Link
        href={`/tokens/${token.address}`}
        key={token.address}
        className="group rounded-xl border border-line bg-black/15 p-4 transition hover:border-cyan/25 hover:bg-white/[.025]"
      >
        <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="font-mono text-xs text-slate-600">{String(index + 1).padStart(2, "0")}</span><TokenIcon label={token.icon} image={token.image}/><div className="min-w-0"><p className="truncate text-sm font-semibold text-white">{token.name}</p><p className="mt-1 font-mono text-[10px] text-slate-500">{token.ticker}</p></div></div><ArrowUpRight className="size-4 text-slate-600 transition group-hover:text-cyan"/></div>
        <div className="mt-5 flex items-end justify-between"><div><p className="text-[10px] uppercase tracking-wider text-slate-600">24h volume</p><p className="mt-1 text-sm font-medium text-white">{money(token.volume24h, true)}</p></div><div className="text-right"><p className="text-[10px] uppercase tracking-wider text-slate-600">Momentum</p><p className="mt-1 text-sm font-semibold text-cyan">{score}</p></div></div>
        <div className="mt-3"><Progress value={score}/></div>
      </Link>)}

      {activeTab === "buys" && latestBuys.length === 0 && <EmptyActivity message="No confirmed buys yet. The feed will update after the first onchain trade."/>}
      {activeTab === "launches" && newLaunches.length === 0 && <EmptyActivity message="No confirmed factory launches yet."/>}
      {activeTab === "trending" && trending.length === 0 && <EmptyActivity message="Trending scores will appear when market activity is available."/>}
    </div>
  </section>;
}

function EmptyActivity({ message }: { message: string }) {
  return <div className="col-span-full flex min-h-32 items-center justify-center rounded-xl border border-dashed border-line px-5 text-center text-sm text-slate-500">{message}</div>;
}
