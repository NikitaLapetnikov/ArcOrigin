"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Check, Copy, ExternalLink } from "lucide-react";
import { BuySellPanel } from "@/components/buy-sell-panel";
import { OnchainTokenDashboard } from "@/components/onchain-token-dashboard";
import { TokenInfoPanel } from "@/components/token-info-panel";
import { Button, Panel, TokenIcon, WarningBox } from "@/components/ui";
import { WatchlistButton } from "@/components/watchlist-button";
import { useFactoryTokenIndex } from "@/hooks/use-factory-token-index";
import { useHolderSnapshot } from "@/hooks/use-holder-snapshot";
import {
  ARC_MAINNET_ORIGIN_POLICY,
  EXPLORER_URL,
  isOfficialOriginToken,
} from "@/lib/chains";
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
  const isOfficialOrigin = isOfficialOriginToken(token.address);
  const heroStats = [
    ["Holders", holderCount > 0 ? number(holderCount) : "—"],
    ["Creator holding", `${(holderSnapshot?.creatorPercent ?? token.creatorAllocationPercent ?? 0).toFixed(2)}%`],
    ["Top 10", holderSnapshot ? `${holderSnapshot.topTenExcludingCurvePercent.toFixed(2)}%` : "—"],
    ["Curve inventory", holderSnapshot ? `${holderSnapshot.curvePercent.toFixed(2)}%` : "—"],
    ["Supply", token.totalSupply ? number(token.totalSupply) : "—"],
  ];

  return <div className="mx-auto w-full max-w-[1800px] px-3 py-3 sm:px-4">
    <div className="mb-4 rounded-[28px] border border-line/70 bg-panel px-4 py-5 shadow-[0_22px_60px_rgba(0,0,0,.12)] sm:px-6 sm:py-6">
      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(390px,1.08fr)_minmax(340px,.92fr)_auto] xl:items-center">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <Link href="/tokens" aria-label="Back to markets" className="grid size-10 shrink-0 place-items-center rounded-full text-slate-400 transition hover:bg-white/[.05] hover:text-white"><ArrowLeft className="size-5"/></Link>
          <TokenIcon label={token.icon} image={token.image} className="size-[92px] shrink-0 rounded-[24px] border-0 text-xl shadow-[0_16px_38px_rgba(0,0,0,.28)] sm:size-[104px]" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="min-w-0 truncate pb-0.5 text-[27px] font-semibold leading-[1.15] tracking-[-.04em] text-white sm:text-[30px]">{token.name}</h1>
              <span className="shrink-0 text-sm font-medium text-slate-400">{tickerLabel(token.ticker)}</span>
              {isOfficialOrigin && <span className="inline-flex h-7 items-center rounded-full border border-cyan/35 bg-cyan/10 px-3 text-[11px] font-semibold uppercase tracking-[.08em] text-cyan">Official</span>}
            </div>
            <button
              type="button"
              onClick={() => void copyContract(token.address)}
              title={token.address}
              aria-label={copied ? "Contract copied" : "Copy token contract"}
              className="mt-3 flex w-full min-w-0 max-w-[440px] items-center gap-2.5 border-b border-line/70 py-2 text-left transition hover:border-cyan/40"
            >
              <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-[.1em] ${copied ? "text-emerald-300" : "text-slate-500"}`}>{copied ? "Copied" : "Contract"}</span>
              <code className="min-w-0 flex-1 truncate text-xs text-slate-200">{token.address}</code>
              {copied ? <Check className="size-4 shrink-0 text-emerald-300"/> : <Copy className="size-4 shrink-0 text-slate-400"/>}
            </button>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
              <span className="text-slate-500">Created by <Link href={`/profile/${token.creator}`} className="ml-1 font-medium text-slate-200 transition hover:text-cyan">{shortAddress(token.creator)}</Link></span>
              <span className="text-slate-500">Launched <span className="ml-1 text-slate-300">{utcDateTime(token.launchedAt)}</span></span>
            </div>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-5 xl:grid-cols-3 2xl:grid-cols-5">
          {heroStats.map(([label, value]) => <div key={label} className="min-w-0">
            <dt className="truncate text-[11px] font-medium uppercase tracking-[.075em] text-slate-500">{label}</dt>
            <dd className="mt-1.5 truncate text-[16px] font-semibold text-slate-100" title={value}>{value}</dd>
          </div>)}
        </dl>
        <div className="flex flex-wrap items-center gap-2 xl:justify-end">
          <WatchlistButton address={token.address} />
          {isOfficialOrigin && <Link
            href="/docs#origin"
            title={`Protocol revenue policy: ${ARC_MAINNET_ORIGIN_POLICY.buybackShareBps / 100}% buyback`}
            className="inline-flex h-10 items-center whitespace-nowrap rounded-full border border-cyan/25 bg-cyan/10 px-4 text-sm font-medium text-cyan transition hover:bg-cyan/15"
          >
            Buyback active
          </Link>}
          <a href={`${EXPLORER_URL}/address/${token.address}`} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-full bg-white/[.045] px-4 text-sm text-slate-200 transition hover:bg-white/[.08] hover:text-white">Arcscan <ExternalLink className="size-4" /></a>
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
