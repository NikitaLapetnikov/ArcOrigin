"use client";

import { ExternalLink, Flame, RefreshCw, ShieldCheck } from "lucide-react";
import { useBuybackSnapshot } from "@/hooks/use-buyback-snapshot";
import { EXPLORER_URL } from "@/lib/chains";
import type { BuybackSnapshot } from "@/lib/onchain/buyback-snapshot";
import type { TokenData } from "@/lib/types";
import { money, number, shortAddress, utcDateTime } from "@/lib/utils";
import { Badge, Button, Panel, WarningBox } from "@/components/ui";

export function BuybackTransparencyPanel({
  token,
  initialSnapshot = null,
}: {
  token: TokenData;
  initialSnapshot?: BuybackSnapshot | null;
}) {
  const enabled = token.automaticBuyback === true;
  const { snapshot, loading, error, stale, refresh } = useBuybackSnapshot(
    token.address,
    enabled,
    initialSnapshot,
  );
  if (!enabled) return null;

  const now = Math.floor(Date.now() / 1_000);
  const status = snapshot?.ready
    ? { label: "Ready", tone: "good" as const, detail: "Eligible for permissionless execution" }
    : snapshot && snapshot.reserveUsdc < 1
      ? { label: "Collecting", tone: "cyan" as const, detail: "Waiting for the 1 USDC minimum" }
      : snapshot && snapshot.nextExecutionAt > now
        ? { label: "Cooldown", tone: "warn" as const, detail: `Next window ${utcDateTime(snapshot.nextExecutionAt)}` }
        : { label: snapshot ? "Protected" : "Syncing", tone: "neutral" as const, detail: snapshot ? "TWAP and price checks apply" : "Loading confirmed onchain totals" };
  const keeperStatus = snapshot?.keeper?.platform
    ? snapshot.keeper.balanceUsdc > 0
      ? { label: "Active", tone: "good" as const }
      : { label: "Needs funds", tone: "warn" as const }
    : { label: "Permissionless", tone: "neutral" as const };

  return <Panel className="overflow-hidden rounded-[24px] shadow-none">
    <div className="flex items-start justify-between gap-3 border-b border-line/70 px-4 py-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-emerald-400/10 text-emerald-300"><Flame className="size-4" /></span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-semibold text-white">Automatic buybacks</h2><Badge tone={status.tone}>{status.label}</Badge>{snapshot && stale && <Badge tone="neutral">Refreshing</Badge>}</div>
          <p className="mt-1 text-[10px] leading-4 text-slate-500">{status.detail}</p>
        </div>
      </div>
      <Button variant="ghost" className="size-8 shrink-0 p-0" aria-label="Refresh buyback data" disabled={loading} onClick={() => void refresh(true)}><RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /></Button>
    </div>

    <div className="grid grid-cols-2 border-b border-line/70 sm:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
      <BuybackMetric label="USDC spent" value={snapshot ? money(snapshot.totalUsdcSpent, true) : "Loading…"} />
      <BuybackMetric label="Bought & burned" value={snapshot ? number(snapshot.totalTokensBurned) : "Loading…"} />
      <BuybackMetric label="Executions" value={snapshot ? number(snapshot.executionCount) : "Loading…"} />
      <BuybackMetric label="Pending reserve" value={snapshot ? money(snapshot.reserveUsdc, true) : "Loading…"} />
    </div>

    <div className="space-y-3 px-4 py-4 text-xs">
      <div className="flex items-center justify-between gap-3"><span className="text-slate-500">Mode</span><span className="inline-flex items-center gap-1.5 font-medium text-emerald-300"><ShieldCheck className="size-3.5" />Enabled forever</span></div>
      <div className="flex items-center justify-between gap-3"><span className="text-slate-500">Automation</span><Badge tone={keeperStatus.tone}>{keeperStatus.label}</Badge></div>
      <div className="flex items-center justify-between gap-3"><span className="text-slate-500">{snapshot?.keeper?.platform ? "Platform keeper" : "Last executor"}</span>{snapshot?.keeper ? <a href={`${EXPLORER_URL}/address/${snapshot.keeper.address}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-slate-200 hover:text-cyan">{shortAddress(snapshot.keeper.address)} · {money(snapshot.keeper.balanceUsdc, true)} <ExternalLink className="size-3" /></a> : <span className="text-slate-600">Anyone may execute</span>}</div>
      <div className="flex items-center justify-between gap-3"><span className="text-slate-500">Last buyback</span>{snapshot?.latestExecution ? <a href={`${EXPLORER_URL}/tx/${snapshot.latestExecution.txHash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-slate-200 hover:text-cyan">{money(snapshot.latestExecution.usdcSpent, true)} · {utcDateTime(snapshot.latestExecution.timestamp)} <ExternalLink className="size-3" /></a> : <span className="text-slate-600">{snapshot ? "No execution yet" : "Loading confirmed data…"}</span>}</div>
      {snapshot && <p className="border-t border-line/70 pt-3 font-mono text-[8px] uppercase tracking-wider text-slate-700">Onchain through block {snapshot.indexedBlock}</p>}
    </div>
    {error && <div className="px-4 pb-4"><WarningBox>{snapshot ? "Showing the last confirmed snapshot while live refresh retries." : error}</WarningBox></div>}
  </Panel>;
}

function BuybackMetric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 border-r border-line/70 px-3 py-3 last:border-r-0"><p className="truncate text-[8px] font-medium uppercase tracking-[.07em] text-slate-600">{label}</p><p className="mt-1 truncate text-xs font-semibold text-slate-200" title={value}>{value}</p></div>;
}
