"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Check, Copy, ExternalLink } from "lucide-react";
import { BuySellPanel } from "@/components/buy-sell-panel";
import { OnchainTokenDashboard } from "@/components/onchain-token-dashboard";
import { TokenInfoPanel } from "@/components/token-info-panel";
import { Badge, Button, Panel, TokenIcon, WarningBox } from "@/components/ui";
import { WatchlistButton } from "@/components/watchlist-button";
import { useFactoryTokenIndex } from "@/hooks/use-factory-token-index";
import { useHolderSnapshot } from "@/hooks/use-holder-snapshot";
import { EXPLORER_URL } from "@/lib/chains";
import { number, shortAddress, tickerLabel, utcDateTime } from "@/lib/utils";

export function IndexedTokenDetail({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const { tokens, loading, error, refresh } = useFactoryTokenIndex({ includeMarketData: false, allowCache: true });
  const token = tokens.find((item) => item.address.toLowerCase() === address.toLowerCase());
  const { snapshot: holderSnapshot } = useHolderSnapshot(token, Boolean(token));

  if (!token) {
    return <div className="container-shell py-12">
      <Panel className="p-6">
        <p className="eyebrow">Verified launch</p>
        <h1 className="mt-3 text-2xl font-semibold text-white">{loading ? "Loading token…" : "Launch not found"}</h1>
        <p className="mt-3 text-sm text-slate-400">{error || (loading ? "Opening the cached token profile while confirmed data refreshes in the background." : "This address was not emitted by the configured ArcOrigin factory.")}</p>
        <div className="mt-5 flex gap-3">
          {!loading && <Button onClick={() => void refresh()}>Retry</Button>}
          <Link href="/tokens" className="inline-flex h-10 items-center rounded-xl border border-line px-4 text-sm text-slate-300">Back to markets</Link>
        </div>
        {error && <div className="mt-4"><WarningBox>{error}</WarningBox></div>}
      </Panel>
    </div>;
  }

  async function copyContract(contractAddress: string) {
    try {
      await navigator.clipboard.writeText(contractAddress);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  }

  const holderCount = holderSnapshot?.holders ?? token.holders;
  const heroStats = [
    ["Holders", holderCount > 0 ? number(holderCount) : "—"],
    ["Creator holding", `${(holderSnapshot?.creatorPercent ?? token.creatorAllocationPercent ?? 0).toFixed(2)}%`],
    ["Top 10", holderSnapshot ? `${holderSnapshot.topTenExcludingCurvePercent.toFixed(2)}%` : "—"],
    ["Curve inventory", holderSnapshot ? `${holderSnapshot.curvePercent.toFixed(2)}%` : "—"],
    ["Supply", token.totalSupply ? number(token.totalSupply) : "—"],
  ];

  return <div className="mx-auto w-full max-w-[1800px] px-3 py-3 sm:px-4">
    <div className="mb-3 rounded-2xl border border-line bg-panel p-4 shadow-[0_18px_50px_rgba(0,0,0,.14)] sm:p-5">
      <div className="grid min-w-0 gap-5 2xl:grid-cols-[minmax(600px,1fr)_minmax(640px,1.05fr)_auto] 2xl:items-center">
        <div className="flex min-w-0 items-start gap-4 sm:items-center">
        <Link href="/tokens" aria-label="Back to markets" className="mt-3 grid size-11 shrink-0 place-items-center rounded-xl border border-line bg-black/10 text-slate-400 transition hover:border-cyan/30 hover:text-white sm:mt-0"><ArrowLeft className="size-5"/></Link>
        <TokenIcon label={token.icon} image={token.image} className="size-20 rounded-2xl text-xl shadow-[0_14px_36px_rgba(0,0,0,.34)] sm:size-24" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="truncate text-2xl font-semibold tracking-[-.04em] text-white sm:text-[28px]">{token.name}</h1>
            <span className="font-mono text-sm text-slate-400">{tickerLabel(token.ticker)}</span>
            <Badge tone="cyan">{token.status}</Badge>
          </div>
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-400">
            <button
              type="button"
              onClick={() => void copyContract(token.address)}
              title={token.address}
              aria-label={copied ? "Contract copied" : "Copy token contract"}
              className="flex min-w-0 max-w-[410px] items-center gap-2.5 rounded-xl border border-line bg-black/20 px-3 py-2 text-left transition hover:border-cyan/30 hover:bg-white/[.025]"
            >
              <span className={`shrink-0 text-[11px] font-medium uppercase tracking-[.08em] ${copied ? "text-emerald-300" : "text-slate-500"}`}>{copied ? "Copied" : "Contract"}</span>
              <code className="min-w-0 flex-1 truncate text-xs text-slate-200">{token.address}</code>
              {copied ? <Check className="size-4 shrink-0 text-emerald-300"/> : <Copy className="size-4 shrink-0 text-slate-400"/>}
            </button>
            <span className="whitespace-nowrap">{utcDateTime(token.launchedAt)}</span>
            <span className="whitespace-nowrap">Creator <Link href={`/creators/${token.creator}`} className="ml-1 text-slate-300 transition hover:text-cyan">{shortAddress(token.creator)}</Link></span>
          </div>
        </div>
      </div>
        <dl className="grid grid-cols-2 overflow-hidden rounded-xl border border-line bg-black/15 sm:grid-cols-3 xl:grid-cols-5">
          {heroStats.map(([label, value]) => <div key={label} className="min-w-0 border-b border-r border-line/70 px-3.5 py-3.5 last:border-r-0 sm:[&:nth-child(n+5)]:border-b-0 xl:border-b-0">
            <dt className="truncate font-mono text-[10px] uppercase tracking-[.08em] text-slate-500">{label}</dt>
            <dd className="mt-1.5 truncate text-sm font-semibold text-slate-100" title={value}>{value}</dd>
          </div>)}
        </dl>
        <div className="flex items-center gap-2 2xl:justify-end">
          <WatchlistButton address={token.address} />
          <a href={`${EXPLORER_URL}/address/${token.address}`} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center gap-2 rounded-xl border border-line px-4 text-sm text-slate-200 transition hover:border-cyan/30 hover:text-white">Arcscan <ExternalLink className="size-4" /></a>
        </div>
      </div>
    </div>

    <OnchainTokenDashboard
      token={token}
      rightRail={<>
        <BuySellPanel token={token} />
        <TokenInfoPanel token={token} />
      </>}
    />
  </div>;
}
