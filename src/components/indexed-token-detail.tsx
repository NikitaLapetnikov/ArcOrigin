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
import { number, shortAddress, utcDateTime } from "@/lib/utils";

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
    ["Permanent lock", holderSnapshot ? `${holderSnapshot.permanentLiquidityLockPercent.toFixed(2)}%` : "—"],
    ["Supply", token.totalSupply ? number(token.totalSupply) : "—"],
  ];

  return <div className="mx-auto w-full max-w-[1800px] px-3 py-3 sm:px-4">
    <div className="mb-3 rounded-xl border border-line bg-panel p-3.5 sm:p-4">
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(480px,.9fr)_minmax(680px,1.1fr)_auto] xl:items-center">
        <div className="flex min-w-0 items-start gap-3 sm:items-center">
        <Link href="/tokens" aria-label="Back to markets" className="mt-2 grid size-10 shrink-0 place-items-center rounded-[10px] border border-line text-slate-500 transition hover:border-slate-500/40 hover:text-white sm:mt-0"><ArrowLeft className="size-4"/></Link>
        <TokenIcon label={token.icon} image={token.image} className="size-16 rounded-2xl text-base shadow-[0_12px_32px_rgba(0,0,0,.28)]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
            <h1 className="truncate text-xl font-semibold tracking-[-.035em] text-white">{token.name}</h1>
            <span className="font-mono text-[11px] text-slate-500">{token.ticker}</span>
            <Badge tone="cyan">{token.status}</Badge>
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 text-[10px] text-slate-500">
            <button
              type="button"
              onClick={() => void copyContract(token.address)}
              title={token.address}
              aria-label={copied ? "Contract copied" : "Copy token contract"}
              className="flex min-w-0 max-w-[360px] items-center gap-2 rounded-lg border border-line bg-black/20 px-2.5 py-1.5 text-left transition hover:border-cyan/30 hover:bg-white/[.025]"
            >
              <span className={`shrink-0 text-[9px] font-medium uppercase tracking-[.08em] ${copied ? "text-emerald-300" : "text-slate-600"}`}>{copied ? "Copied" : "Contract"}</span>
              <code className="min-w-0 flex-1 truncate text-[10px] text-slate-300">{token.address}</code>
              {copied ? <Check className="size-3.5 shrink-0 text-emerald-300"/> : <Copy className="size-3.5 shrink-0 text-slate-500"/>}
            </button>
            <span className="whitespace-nowrap">{utcDateTime(token.launchedAt)}</span>
            <span className="whitespace-nowrap">Creator <Link href={`/creators/${token.creator}`} className="ml-1 text-slate-300 transition hover:text-cyan">{shortAddress(token.creator)}</Link></span>
          </div>
        </div>
      </div>
        <dl className="grid grid-cols-2 overflow-hidden rounded-[10px] border border-line bg-black/15 sm:grid-cols-3 xl:grid-cols-6">
          {heroStats.map(([label, value]) => <div key={label} className="min-w-0 border-b border-r border-line/70 px-3 py-2.5 last:border-r-0 sm:[&:nth-child(n+5)]:border-b-0 xl:border-b-0">
            <dt className="truncate font-mono text-[8px] uppercase tracking-[.08em] text-slate-600">{label}</dt>
            <dd className="mt-1 truncate text-[11px] font-semibold text-slate-200" title={value}>{value}</dd>
          </div>)}
        </dl>
        <div className="flex items-center gap-2">
          <WatchlistButton address={token.address} />
          <a href={`${EXPLORER_URL}/address/${token.address}`} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-line px-3 text-xs text-slate-300 transition hover:border-cyan/30 hover:text-white">Arcscan <ExternalLink className="size-3" /></a>
        </div>
      </div>
    </div>

    <OnchainTokenDashboard
      token={token}
      creatorTokens={tokens.filter((item) => item.creator.toLowerCase() === token.creator.toLowerCase())}
      rightRail={<>
        <BuySellPanel token={token} />
        <TokenInfoPanel token={token} />
      </>}
    />
  </div>;
}
