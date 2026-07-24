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
import { EXPLORER_URL } from "@/lib/chains";
import { shortAddress, utcDateTime } from "@/lib/utils";

export function IndexedTokenDetail({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const { tokens, loading, error, refresh } = useFactoryTokenIndex({ includeMarketData: false, allowCache: true });
  const token = tokens.find((item) => item.address.toLowerCase() === address.toLowerCase());

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

  return <div className="mx-auto w-full max-w-[1800px] px-3 py-3 sm:px-4">
    <div className="mb-3 grid gap-5 rounded-xl border border-line bg-panel p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
      <div className="flex min-w-0 items-start gap-3 sm:items-center sm:gap-4">
        <Link href="/tokens" aria-label="Back to markets" className="mt-2 grid size-10 shrink-0 place-items-center rounded-[10px] border border-line text-slate-500 transition hover:border-slate-500/40 hover:text-white sm:mt-0"><ArrowLeft className="size-4"/></Link>
        <TokenIcon label={token.icon} image={token.image} className="size-[72px] rounded-2xl text-base shadow-[0_12px_32px_rgba(0,0,0,.28)]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
            <h1 className="truncate text-2xl font-semibold tracking-[-.035em] text-white">{token.name}</h1>
            <span className="font-mono text-[11px] text-slate-500">{token.ticker}</span>
            <Badge tone="cyan">{token.status}</Badge>
          </div>
          <div className="mt-3 grid gap-x-6 gap-y-2 text-[11px] text-slate-500 sm:grid-cols-[minmax(240px,auto)_auto_auto] sm:items-center">
            <button
              type="button"
              onClick={() => void copyContract(token.address)}
              title={token.address}
              aria-label={copied ? "Contract copied" : "Copy token contract"}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-black/20 px-3 py-2 text-left transition hover:border-cyan/30 hover:bg-white/[.025]"
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
      <div className="flex items-center gap-2 pl-[88px] lg:pl-0">
        <WatchlistButton address={token.address} />
        <a href={`${EXPLORER_URL}/address/${token.address}`} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-[10px] border border-line px-3 text-xs text-slate-300 transition hover:border-cyan/30 hover:text-white">Arcscan <ExternalLink className="size-3" /></a>
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
