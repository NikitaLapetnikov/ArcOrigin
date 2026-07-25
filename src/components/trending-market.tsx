"use client";

import Link from "next/link";
import { ArrowUpRight, Flame } from "lucide-react";
import { useFactoryTokenIndex } from "@/hooks/use-factory-token-index";
import { calculateMomentumScore } from "@/lib/scoring";
import { money } from "@/lib/utils";
import { EmptyState, Progress, TokenIcon, WarningBox } from "./ui";

export function TrendingMarket() {
  const { tokens: indexedTokens, loading, error, isPartial, refresh } = useFactoryTokenIndex();
  const ranked = indexedTokens
    .map((token) => ({ token, score: calculateMomentumScore(token) }))
    .sort((left, right) => right.score - left.score);

  return <div className="container-shell pb-20">
    {error && <div className="mb-5 flex items-center gap-3"><div className="flex-1"><WarningBox>{error}</WarningBox></div><button onClick={() => void refresh()} className="shrink-0 text-xs font-semibold text-cyan">Retry live data</button></div>}
    {ranked.length === 0 && !loading ? <EmptyState title="No confirmed market activity" body="Trending tokens will appear after Factory launches are indexed from Arc Testnet."/> : <div className="panel overflow-hidden">{ranked.map(({token},index) => {
      const onchainUnavailable = isPartial || (loading && indexedTokens.length === 0);
      return <Link href={`/tokens/${token.address}`} key={token.address} className="grid items-center gap-4 border-b border-line/70 p-4 transition last:border-0 hover:bg-white/[.025] md:grid-cols-[56px_1.3fr_1fr_1fr_1fr_auto]">
        <div className="flex items-center gap-2"><span className="font-mono text-lg text-slate-600">{String(index + 1).padStart(2,"0")}</span>{index < 3 && <Flame className="size-4 text-amber-300"/>}</div>
        <div className="flex items-center gap-3"><TokenIcon label={token.icon} image={token.image}/><div><p className="font-semibold text-white">{token.name}</p><p className="text-[10px] text-slate-500">{token.ticker}</p></div></div>
        <div><p className="text-[10px] font-medium uppercase tracking-[.08em] text-slate-600">Market cap</p><p className="mt-1 text-lg font-semibold text-white">{onchainUnavailable ? "—" : money(token.marketCap,true)}</p></div>
        <div><p className="font-mono text-[9px] uppercase tracking-wider text-slate-600">Volume</p><p className="mt-1 text-sm text-slate-200">{onchainUnavailable ? "RPC unavailable" : money(token.volume24h,true)}</p></div>
        <div><div className="mb-2 flex justify-between text-[10px] text-slate-500"><span>Curve</span><span>{onchainUnavailable ? "—" : `${token.curveProgress.toFixed(2)}%`}</span></div><Progress value={onchainUnavailable ? 0 : token.curveProgress}/></div>
        <ArrowUpRight className="size-4 text-slate-600"/>
      </Link>;
    })}</div>}
  </div>;
}
