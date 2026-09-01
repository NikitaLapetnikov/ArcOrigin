"use client";

import Link from "next/link";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Coins,
  ExternalLink,
  Flame,
  Radio,
  RefreshCw,
  Repeat2,
  ShieldCheck,
  Sparkles,
  UsersRound,
  WalletCards,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ANALYTICS_RANGES,
  type AnalyticsMarket,
  type AnalyticsRange,
  type AnalyticsSeriesPoint,
  type ProtocolAnalyticsSnapshot,
} from "@/lib/analytics";
import { cn, money, number, shortAddress, tickerLabel } from "@/lib/utils";
import { Badge, TokenIcon } from "@/components/ui";

type Props = { initialSnapshot?: ProtocolAnalyticsSnapshot | null; initialStale?: boolean };

const RANGE_LABELS: Record<AnalyticsRange, string> = {
  "24h": "24H",
  "7d": "7D",
  "30d": "30D",
  all: "All time",
};

export function ProtocolAnalytics({ initialSnapshot = null, initialStale = false }: Props) {
  const [range, setRange] = useState<AnalyticsRange>(initialSnapshot?.range ?? "24h");
  const [snapshot, setSnapshot] = useState<ProtocolAnalyticsSnapshot | null>(initialSnapshot);
  const [loading, setLoading] = useState(!initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(initialStale);
  const [error, setError] = useState("");
  const requestRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (nextRange: AnalyticsRange, background = false) => {
    const requestId = ++requestRef.current;
    if (background) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch(`/api/onchain/analytics?range=${nextRange}${background ? "&refresh=1" : ""}`, { cache: "no-store" });
      const payload = await response.json() as { snapshot?: ProtocolAnalyticsSnapshot; stale?: boolean; error?: string };
      if (requestId !== requestRef.current) return;
      if (!response.ok || !payload.snapshot) throw new Error(payload.error ?? "Analytics could not be loaded.");
      setSnapshot(payload.snapshot);
      setStale(payload.stale === true);
      setError("");
    } catch (loadError) {
      if (requestId !== requestRef.current) return;
      setError(loadError instanceof Error ? loadError.message : "Analytics could not be loaded.");
    } finally {
      if (requestId === requestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (initialSnapshot?.range === range && !initialStale) return;
    void load(range, initialStale);
  }, [initialSnapshot?.range, initialStale, load, range]);

  useEffect(() => {
    const scheduleRefresh = () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => void load(range, true), 700);
    };
    window.addEventListener("arcorigin:indexer-event", scheduleRefresh);
    const poll = window.setInterval(() => void load(range, true), 20_000);
    return () => {
      window.removeEventListener("arcorigin:indexer-event", scheduleRefresh);
      window.clearInterval(poll);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [load, range]);

  const selectRange = (nextRange: AnalyticsRange) => {
    if (nextRange === range) return;
    setRange(nextRange);
    setError("");
  };

  if (!snapshot && loading) return <AnalyticsLoading />;
  if (!snapshot) return <AnalyticsUnavailable error={error} onRetry={() => void load(range)} />;

  const rangeLabel = RANGE_LABELS[range];
  const metrics = snapshot.metrics;
  const indexAgeSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(snapshot.generatedAt)) / 1_000));
  const catchingUp = stale || indexAgeSeconds > 60;
  return <div className="container-shell pb-12 pt-8 md:pb-16 md:pt-11">
    <section className="relative overflow-hidden rounded-[26px] border border-line bg-panel shadow-glow">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(800px_330px_at_0%_0%,rgba(57,189,248,.14),transparent_64%),radial-gradient(600px_300px_at_100%_0%,rgba(117,103,255,.12),transparent_68%)]" />
      <div className="relative flex flex-col gap-6 px-5 py-6 sm:px-7 sm:py-8 lg:flex-row lg:items-end lg:justify-between lg:px-9">
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className={cn(
              "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[.11em]",
              catchingUp
                ? "border-amber-300/20 bg-amber-300/[.07] text-amber-200"
                : "border-emerald-400/20 bg-emerald-400/[.07] text-emerald-300",
            )}>
              <Radio className={cn("size-3.5", !catchingUp && "animate-pulse")} />{catchingUp ? "Indexer catching up" : "Live onchain"}
            </span>
            <Badge tone="cyan">Arc mainnet</Badge>
            {snapshot.preview && <Badge tone="warn">Local preview data</Badge>}
          </div>
          <h1 className="text-[36px] font-semibold leading-[1.04] tracking-[-.055em] text-white sm:text-[46px]">Protocol analytics</h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-400 sm:text-[15px]">
            A transparent view of ArcOrigin-native markets, trading activity, fee routing and automatic buyback impact.
          </p>
        </div>
        <div className="shrink-0">
          <div className="inline-flex w-full rounded-xl border border-line bg-black/20 p-1 sm:w-auto" role="tablist" aria-label="Analytics period">
            {ANALYTICS_RANGES.map((item) => <button
              key={item}
              type="button"
              role="tab"
              aria-selected={range === item}
              onClick={() => selectRange(item)}
              className={cn(
                "h-9 flex-1 whitespace-nowrap rounded-lg px-3 text-xs font-semibold transition sm:flex-none sm:px-4",
                range === item
                  ? "bg-cyan text-[#041018] shadow-[0_8px_22px_rgba(57,189,248,.16)]"
                  : "text-slate-400 hover:bg-white/[.04] hover:text-white",
              )}
            >{RANGE_LABELS[item]}</button>)}
          </div>
          <div className="mt-3 flex items-center justify-end gap-2 text-[10px] text-slate-500">
            <span>Block {Number(snapshot.indexedBlock).toLocaleString("en-US")}</span>
            <span aria-hidden="true">•</span>
            <span>{formatUpdated(snapshot.generatedAt)}</span>
            <button
              type="button"
              aria-label="Refresh protocol analytics"
              onClick={() => void load(range, true)}
              className="grid size-7 place-items-center rounded-lg text-slate-500 transition hover:bg-white/[.05] hover:text-white"
            ><RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} /></button>
          </div>
        </div>
      </div>
    </section>

    {error && <div className="mt-4 rounded-xl border border-amber-300/15 bg-amber-300/[.05] px-4 py-3 text-xs text-amber-200">Showing the last indexed snapshot. {error}</div>}

    <section className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6" aria-label={`${rangeLabel} overview`}>
      <MetricCard icon={BarChart3} label={`${rangeLabel} volume`} value={money(metrics.volumeUsdc, true)} detail="Confirmed USDC notional" accent />
      <MetricCard icon={Repeat2} label={`${rangeLabel} trades`} value={number(metrics.trades)} detail="Confirmed pool swaps" />
      <MetricCard icon={UsersRound} label="Unique traders" value={number(metrics.traders)} detail={`During ${rangeLabel.toLowerCase()}`} />
      <MetricCard icon={Sparkles} label="New markets" value={number(metrics.launches)} detail={`During ${rangeLabel.toLowerCase()}`} />
      <MetricCard icon={Coins} label="Native markets" value={number(snapshot.allTime.launches)} detail={`${snapshot.allTime.creators} unique creators`} />
      <MetricCard icon={WalletCards} label="Current holders" value={number(snapshot.allTime.holders)} detail="Excludes pools and burn" />
    </section>

    <section className="mt-4 grid gap-4 xl:grid-cols-[1.45fr_.85fr]">
      <AnalyticsPanel title="Trading volume" subtitle={`${rangeLabel} · confirmed USDC notional`} value={money(metrics.volumeUsdc, true)}>
        <VolumeChart points={snapshot.series} range={range} />
      </AnalyticsPanel>
      <AnalyticsPanel title="Protocol activity" subtitle="Trades and native launches" value={`${number(metrics.trades)} trades`}>
        <ActivityChart points={snapshot.series} range={range} />
      </AnalyticsPanel>
    </section>

    <FeeEconomics snapshot={snapshot} rangeLabel={rangeLabel} />

    <section className="mt-4 grid gap-4 xl:grid-cols-[.75fr_1.25fr]">
      <LaunchModePanel snapshot={snapshot} />
      <TopMarkets markets={snapshot.markets} rangeLabel={rangeLabel} />
    </section>

    <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-line bg-white/[.018] px-4 py-4 text-[11px] leading-5 text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <p>Metrics come from the dedicated ArcOrigin event indexer. Fee-equivalent values apply the immutable 1% pool tier to indexed swap notional; actual routed balances settle when LP fees are collected.</p>
      <Link href="/docs" className="inline-flex shrink-0 items-center gap-1.5 font-semibold text-cyan transition hover:text-white">Mechanics & docs <ArrowRight className="size-3.5" /></Link>
    </div>
  </div>;
}

function MetricCard({ icon: Icon, label, value, detail, accent = false }: { icon: LucideIcon; label: string; value: string; detail: string; accent?: boolean }) {
  return <article className={cn(
    "group relative min-w-0 overflow-hidden rounded-2xl border border-line bg-panel p-4 shadow-glow sm:p-5",
    accent && "border-cyan/25",
  )}>
    {accent && <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(280px_150px_at_0%_0%,rgba(57,189,248,.16),transparent_70%)]" />}
    <div className="relative flex min-h-8 items-start justify-between gap-2">
      <p className="pt-1 text-[9px] font-semibold uppercase leading-4 tracking-[.08em] text-slate-500 sm:text-[10px]">{label}</p>
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-white/[.03] text-slate-500", accent && "border-cyan/20 bg-cyan/[.07] text-cyan")}><Icon className="size-3.5" /></span>
    </div>
    <p className="relative mt-3 truncate text-[25px] font-semibold tracking-[-.045em] text-white sm:text-[28px]">{value}</p>
    <p className="relative mt-1.5 min-h-4 text-[9px] leading-4 text-slate-500 sm:text-[10px]">{detail}</p>
  </article>;
}

function AnalyticsPanel({ title, subtitle, value, children }: { title: string; subtitle: string; value: string; children: React.ReactNode }) {
  return <article className="overflow-hidden rounded-[22px] border border-line bg-panel shadow-glow">
    <header className="flex items-start justify-between gap-5 border-b border-line px-5 py-5 sm:px-6">
      <div><h2 className="text-base font-semibold tracking-[-.025em] text-white sm:text-lg">{title}</h2><p className="mt-1 text-[11px] text-slate-500">{subtitle}</p></div>
      <p className="shrink-0 font-mono text-sm font-semibold text-slate-200">{value}</p>
    </header>
    <div className="p-4 sm:p-5">{children}</div>
  </article>;
}

function VolumeChart({ points, range }: { points: AnalyticsSeriesPoint[]; range: AnalyticsRange }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const max = Math.max(...points.map((point) => point.volumeUsdc), 1);
  const chartWidth = 720;
  const chartHeight = 250;
  const horizontalPadding = 16;
  const top = 20;
  const bottom = 36;
  const usableHeight = chartHeight - top - bottom;
  const gap = points.length > 30 ? 2.5 : points.length > 12 ? 5 : 9;
  const plotWidth = chartWidth - horizontalPadding * 2;
  const barWidth = Math.max(3, (plotWidth - gap * Math.max(0, points.length - 1)) / Math.max(1, points.length));
  const active = activeIndex === null ? points.at(-1) : points[activeIndex];

  if (points.length === 0) return <ChartEmpty />;
  return <div className="relative h-[260px] overflow-hidden rounded-xl border border-line bg-black/10">
    <div className="pointer-events-none absolute left-4 top-3 z-10 rounded-lg border border-line bg-[var(--surface-2)] px-3 py-2 shadow-lg">
      <p className="font-mono text-xs font-semibold text-white">{money(active?.volumeUsdc ?? 0)}</p>
      <p className="mt-0.5 text-[9px] text-slate-500">{active ? formatChartTime(active.timestamp, range) : "No activity"}</p>
    </div>
    <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" className="h-full w-full" role="img" aria-label="Trading volume chart" onPointerLeave={() => setActiveIndex(null)}>
      <defs>
        <linearGradient id="analytics-volume" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" />
          <stop offset="100%" stopColor="var(--accent-violet)" stopOpacity=".42" />
        </linearGradient>
      </defs>
      {[0, 1, 2, 3].map((line) => <line key={line} x1={horizontalPadding} x2={chartWidth - horizontalPadding} y1={top + usableHeight * line / 3} y2={top + usableHeight * line / 3} stroke="var(--border)" strokeDasharray="4 7" />)}
      {points.map((point, index) => {
        const height = Math.max(2, point.volumeUsdc / max * usableHeight);
        const x = horizontalPadding + index * (barWidth + gap);
        const selected = activeIndex === index || (activeIndex === null && index === points.length - 1);
        return <rect
          key={`${point.timestamp}-${index}`}
          x={x}
          y={top + usableHeight - height}
          width={barWidth}
          height={height}
          rx={Math.min(5, barWidth / 2)}
          fill="url(#analytics-volume)"
          opacity={selected ? 1 : .56}
          className="cursor-crosshair transition-opacity"
          onPointerEnter={() => setActiveIndex(index)}
        ><title>{`${formatChartTime(point.timestamp, range)} · ${money(point.volumeUsdc)}`}</title></rect>;
      })}
      <ChartAxisLabels points={points} range={range} width={chartWidth} y={chartHeight - 11} padding={horizontalPadding} />
    </svg>
  </div>;
}

function ActivityChart({ points, range }: { points: AnalyticsSeriesPoint[]; range: AnalyticsRange }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const chartWidth = 480;
  const chartHeight = 250;
  const horizontalPadding = 16;
  const top = 24;
  const bottom = 36;
  const maxTrades = Math.max(...points.map((point) => point.trades), 1);
  const plotWidth = chartWidth - horizontalPadding * 2;
  const step = points.length > 1 ? plotWidth / (points.length - 1) : plotWidth;
  const y = (value: number) => top + (chartHeight - top - bottom) * (1 - value / maxTrades);
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${horizontalPadding + index * step},${y(point.trades)}`).join(" ");
  const active = activeIndex === null ? points.at(-1) : points[activeIndex];

  if (points.length === 0) return <ChartEmpty />;
  return <div className="relative h-[260px] overflow-hidden rounded-xl border border-line bg-black/10">
    <div className="pointer-events-none absolute left-4 top-3 z-10 flex items-center gap-4 rounded-lg border border-line bg-[var(--surface-2)] px-3 py-2 shadow-lg">
      <span><span className="block font-mono text-xs font-semibold text-white">{active?.trades ?? 0}</span><span className="text-[9px] text-slate-500">trades</span></span>
      <span><span className="block font-mono text-xs font-semibold text-cyan">{active?.launches ?? 0}</span><span className="text-[9px] text-slate-500">launches</span></span>
    </div>
    <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" className="h-full w-full" role="img" aria-label="Protocol activity chart" onPointerLeave={() => setActiveIndex(null)}>
      <defs>
        <linearGradient id="analytics-activity-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".22"/><stop offset="100%" stopColor="var(--accent)" stopOpacity="0"/></linearGradient>
      </defs>
      {[0, 1, 2, 3].map((grid) => <line key={grid} x1={horizontalPadding} x2={chartWidth - horizontalPadding} y1={top + (chartHeight - top - bottom) * grid / 3} y2={top + (chartHeight - top - bottom) * grid / 3} stroke="var(--border)" strokeDasharray="4 7" />)}
      <path d={`${line} L${chartWidth - horizontalPadding},${chartHeight - bottom} L${horizontalPadding},${chartHeight - bottom} Z`} fill="url(#analytics-activity-fill)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="3" vectorEffect="non-scaling-stroke" />
      {points.map((point, index) => {
        const x = horizontalPadding + index * step;
        return <g key={`${point.timestamp}-${index}`} onPointerEnter={() => setActiveIndex(index)} className="cursor-crosshair">
          <rect x={Math.max(0, x - Math.max(6, step / 2))} y="0" width={Math.max(12, step)} height={chartHeight} fill="transparent" />
          {point.launches > 0 && <circle cx={x} cy={Math.max(top + 10, y(point.trades) - 13)} r={4 + Math.min(3, point.launches)} fill="var(--accent-violet)" stroke="var(--surface-1)" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
          {(activeIndex === index || (activeIndex === null && index === points.length - 1)) && <circle cx={x} cy={y(point.trades)} r="5" fill="var(--accent)" stroke="var(--surface-1)" strokeWidth="3" vectorEffect="non-scaling-stroke" />}
        </g>;
      })}
      <ChartAxisLabels points={points} range={range} width={chartWidth} y={chartHeight - 11} padding={horizontalPadding} />
    </svg>
  </div>;
}

function ChartAxisLabels({ points, range, width, y, padding = 0 }: { points: AnalyticsSeriesPoint[]; range: AnalyticsRange; width: number; y: number; padding?: number }) {
  const indexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  return <>{indexes.map((index) => <text
    key={index}
    x={points.length > 1 ? padding + index / (points.length - 1) * (width - padding * 2) : width / 2}
    y={y}
    fill="var(--text-tertiary)"
    fontSize="10"
    textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}
  >{formatChartTime(points[index].timestamp, range)}</text>)}</>;
}

function ChartEmpty() {
  return <div className="grid h-[260px] place-items-center rounded-xl border border-dashed border-line bg-black/10 text-xs text-slate-500">No indexed activity in this period.</div>;
}

function FeeEconomics({ snapshot, rangeLabel }: { snapshot: ProtocolAnalyticsSnapshot; rangeLabel: string }) {
  const economics = snapshot.economics;
  return <section className="mt-4 overflow-hidden rounded-[22px] border border-line bg-panel shadow-glow">
    <header className="flex flex-col gap-3 border-b border-line px-5 py-5 sm:flex-row sm:items-end sm:justify-between sm:px-6">
      <div><p className="eyebrow mb-2">Fee economics</p><h2 className="text-xl font-semibold tracking-[-.035em] text-white">Fee routing and permanent burn impact</h2><p className="mt-2 text-[11px] text-slate-500">{rangeLabel} fee-equivalent routing and confirmed onchain outcomes.</p></div>
      <span className="inline-flex w-fit items-center gap-2 rounded-full border border-cyan/20 bg-cyan/[.06] px-3 py-1.5 text-[10px] font-semibold text-cyan"><ShieldCheck className="size-3.5" />Immutable 70 / 30 split</span>
    </header>
    <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-4">
      <EconomicsCard icon={Zap} label="Trading fee equivalent" value={money(economics.feeEquivalentUsdc)} detail="1% pool fee tier" tone="cyan" />
      <EconomicsCard icon={WalletCards} label="Creator routing" value={money(economics.creatorEarningsEquivalentUsdc)} detail="70% on standard launches" />
      <EconomicsCard icon={ShieldCheck} label="Protocol routing" value={money(economics.protocolRevenueEquivalentUsdc)} detail="30% of fee equivalent" />
      <EconomicsCard icon={Flame} label="Buyback fee impact" value={money(economics.buybackAllocationEquivalentUsdc)} detail="Estimated USDC equivalent · not pending debt" tone="violet" />
    </div>
    <div className="border-t border-line p-4 sm:p-5">
      <div className="grid gap-3 xl:grid-cols-[1.35fr_.65fr]">
        <article className="relative overflow-hidden rounded-2xl border border-violet/25 bg-violet/[.055] p-5 sm:p-6">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(520px_240px_at_100%_0%,rgba(117,103,255,.18),transparent_68%),radial-gradient(360px_220px_at_0%_100%,rgba(57,189,248,.12),transparent_72%)]" />
          <div className="relative">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[10px] font-semibold uppercase tracking-[.1em] text-violet">Permanent supply reduction · {rangeLabel}</p>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300/20 bg-emerald-300/[.07] px-2.5 py-1 text-[9px] font-semibold uppercase tracking-[.08em] text-emerald-300"><Flame className="size-3" />100% of buyback output burned</span>
            </div>
            <p className="mt-5 text-[38px] font-semibold leading-none tracking-[-.055em] text-white sm:text-[50px]">{number(economics.tokensBurned)} <span className="text-[17px] tracking-[-.025em] text-slate-400 sm:text-xl">tokens</span></p>
            <p className="mt-3 max-w-xl text-xs leading-5 text-slate-400">Permanently removed from circulation. Every token acquired by an automatic buyback is burned in the same onchain execution.</p>
            <div className="mt-6 flex flex-col gap-3 rounded-xl border border-white/[.07] bg-black/15 px-4 py-3.5 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1"><p className="text-[9px] font-semibold uppercase tracking-[.08em] text-slate-500">USDC converted into burns</p><p className="mt-1 font-mono text-lg font-semibold text-white">{money(economics.buybackSpentUsdc)}</p></div>
              <ArrowRight className="hidden size-4 shrink-0 text-violet sm:block" />
              <div className="min-w-0 flex-1 sm:text-right"><p className="text-[9px] font-semibold uppercase tracking-[.08em] text-slate-500">Confirmed executions</p><p className="mt-1 font-mono text-lg font-semibold text-white">{number(economics.buybackExecutions)}</p></div>
            </div>
          </div>
        </article>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <BuybackProofCard icon={Repeat2} label="Onchain conversion" value={`${money(economics.buybackSpentUsdc)} spent`} note="Actual USDC used by confirmed buybacks in the selected period." />
          <BuybackProofCard icon={Activity} label="Protected automation" value="Permissionless" note="TWAP, cooldown and price-impact limits protect every execution." />
        </div>
      </div>
      <p className="mt-3 text-[10px] leading-5 text-slate-500">The fee-impact figure is an estimated USDC equivalent, not an unpaid balance. Launch-token LP fees are burned directly when collected and are additional to the confirmed buyback output shown above.</p>
    </div>
  </section>;
}

function EconomicsCard({ icon: Icon, label, value, detail, tone }: { icon: LucideIcon; label: string; value: string; detail: string; tone?: "cyan" | "violet" }) {
  return <article className={cn(
    "rounded-2xl border border-line bg-black/15 p-4",
    tone === "cyan" && "border-cyan/20 bg-cyan/[.045]",
    tone === "violet" && "border-violet/20 bg-violet/[.045]",
  )}>
    <div className="flex items-center justify-between gap-3"><p className="text-[11px] font-medium text-slate-500">{label}</p><Icon className={cn("size-4 text-slate-600", tone === "cyan" && "text-cyan", tone === "violet" && "text-violet")} /></div>
    <p className="mt-6 text-[24px] font-semibold tracking-[-.04em] text-white">{value}</p>
    <p className="mt-1.5 text-[10px] text-slate-500">{detail}</p>
  </article>;
}

function BuybackProofCard({ label, value, note, icon: Icon }: { label: string; value: string; note: string; icon: LucideIcon }) {
  return <article className="rounded-2xl border border-line bg-black/15 p-4 sm:p-5">
    <div className="flex items-start justify-between gap-3"><p className="text-[10px] font-semibold uppercase tracking-[.08em] text-slate-500">{label}</p><span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-white/[.03] text-cyan"><Icon className="size-3.5" /></span></div>
    <p className="mt-5 text-xl font-semibold tracking-[-.035em] text-white">{value}</p>
    <p className="mt-2 text-[10px] leading-5 text-slate-500">{note}</p>
  </article>;
}

function LaunchModePanel({ snapshot }: { snapshot: ProtocolAnalyticsSnapshot }) {
  const total = Math.max(1, snapshot.launchModes.standard + snapshot.launchModes.automaticBuyback);
  const automaticPercent = snapshot.launchModes.automaticBuyback / total * 100;
  return <article className="rounded-[22px] border border-line bg-panel p-5 shadow-glow sm:p-6">
    <p className="eyebrow mb-2">Launch architecture</p>
    <h2 className="text-lg font-semibold tracking-[-.03em] text-white">Native market modes</h2>
    <p className="mt-2 text-[11px] leading-5 text-slate-500">Every launch starts in a permanently locked Uniswap V3 position.</p>
    <div className="mt-7 flex items-center gap-6">
      <div className="relative grid size-32 shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(var(--accent) 0 ${automaticPercent}%, var(--accent-violet) ${automaticPercent}% 100%)` }}>
        <div className="grid size-[98px] place-items-center rounded-full border border-line bg-[var(--surface-1)] text-center shadow-inner">
          <span><strong className="block text-2xl font-semibold tracking-[-.04em] text-white">{snapshot.allTime.launches}</strong><span className="text-[9px] uppercase tracking-[.08em] text-slate-500">markets</span></span>
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-4">
        <DistributionRow label="Auto buyback" value={snapshot.launchModes.automaticBuyback} percent={automaticPercent} color="bg-cyan" />
        <DistributionRow label="Creator fees" value={snapshot.launchModes.standard} percent={100 - automaticPercent} color="bg-violet" />
      </div>
    </div>
    <div className="mt-7 rounded-xl border border-line bg-black/15 px-4 py-3 text-[10px] leading-5 text-slate-500">Mode is immutable after launch. The auto-buyback badge is sourced from the Factory record, not token metadata.</div>
  </article>;
}

function DistributionRow({ label, value, percent, color }: { label: string; value: number; percent: number; color: string }) {
  return <div><div className="flex items-center justify-between gap-3 text-xs"><span className="inline-flex items-center gap-2 text-slate-400"><span className={cn("size-2 rounded-full", color)} />{label}</span><span className="font-mono font-semibold text-slate-200">{value} · {percent.toFixed(0)}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[.05]"><div className={cn("h-full rounded-full", color)} style={{ width: `${percent}%` }} /></div></div>;
}

function TopMarkets({ markets, rangeLabel }: { markets: AnalyticsMarket[]; rangeLabel: string }) {
  return <article className="overflow-hidden rounded-[22px] border border-line bg-panel shadow-glow">
    <header className="flex items-end justify-between gap-4 border-b border-line px-5 py-5 sm:px-6">
      <div><p className="eyebrow mb-2">Market leaderboard</p><h2 className="text-lg font-semibold tracking-[-.03em] text-white">Top native markets</h2></div>
      <span className="text-[10px] text-slate-500">By {rangeLabel} volume</span>
    </header>
    {markets.length > 0 ? <div className="divide-y divide-line">
      <div className="hidden grid-cols-[minmax(0,1.5fr)_.75fr_.55fr_.55fr_24px] gap-3 px-5 py-3 text-[9px] font-semibold uppercase tracking-[.09em] text-slate-600 sm:grid sm:px-6"><span>Market</span><span className="text-right">Volume</span><span className="text-right">Trades</span><span className="text-right">Traders</span><span /></div>
      {markets.map((market, index) => <Link key={market.address} href={`/tokens/${market.address}`} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5 transition hover:bg-white/[.025] sm:grid-cols-[minmax(0,1.5fr)_.75fr_.55fr_.55fr_24px] sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="w-5 shrink-0 font-mono text-[10px] text-slate-600">{String(index + 1).padStart(2, "0")}</span>
          <TokenIcon label={market.symbol.slice(0, 2)} className="size-9 rounded-[10px]" />
          <div className="min-w-0"><div className="flex items-center gap-2"><p className="truncate text-sm font-semibold text-white">{market.name}</p>{market.automaticBuyback && <span title="Automatic buyback" className="grid size-4 shrink-0 place-items-center rounded-full bg-cyan/10 text-cyan"><Flame className="size-2.5" /></span>}</div><p className="mt-0.5 truncate font-mono text-[10px] text-slate-500">{tickerLabel(market.symbol)} · {shortAddress(market.address)}</p></div>
        </div>
        <p className="text-right font-mono text-xs font-semibold text-slate-200">{money(market.volumeUsdc, true)}</p>
        <p className="hidden text-right font-mono text-xs text-slate-400 sm:block">{number(market.trades)}</p>
        <p className="hidden text-right font-mono text-xs text-slate-400 sm:block">{number(market.traders)}</p>
        <ExternalLink className="hidden size-3.5 text-slate-600 transition group-hover:text-cyan sm:block" />
      </Link>)}
    </div> : <div className="grid min-h-64 place-items-center p-8 text-center text-xs text-slate-500">No indexed markets in this period.</div>}
  </article>;
}

function AnalyticsLoading() {
  return <div className="container-shell pb-16 pt-10" aria-busy="true">
    <div className="h-52 animate-pulse rounded-[26px] border border-line bg-panel" />
    <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-6">{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-36 animate-pulse rounded-2xl border border-line bg-panel" />)}</div>
    <div className="mt-4 grid gap-4 xl:grid-cols-[1.45fr_.85fr]"><div className="h-96 animate-pulse rounded-[22px] border border-line bg-panel"/><div className="h-96 animate-pulse rounded-[22px] border border-line bg-panel"/></div>
  </div>;
}

function AnalyticsUnavailable({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <div className="container-shell py-20"><div className="mx-auto max-w-xl rounded-[24px] border border-line bg-panel p-8 text-center shadow-glow"><Activity className="mx-auto size-7 text-slate-500"/><h1 className="mt-5 text-2xl font-semibold text-white">Analytics are catching up</h1><p className="mt-3 text-sm leading-6 text-slate-500">{error || "The event indexer has not published a protocol snapshot yet."}</p><button type="button" onClick={onRetry} className="mt-6 inline-flex h-10 items-center gap-2 rounded-xl bg-cyan px-4 text-xs font-semibold text-[#041018]"><RefreshCw className="size-3.5"/>Retry</button></div></div>;
}

function formatUpdated(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Update pending";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 10) return "Updated now";
  if (seconds < 60) return `Updated ${seconds}s ago`;
  if (seconds < 3_600) return `Updated ${Math.floor(seconds / 60)}m ago`;
  return `Updated ${Math.floor(seconds / 3_600)}h ago`;
}

function formatChartTime(timestamp: number, range: AnalyticsRange) {
  const date = new Date(timestamp * 1_000);
  return new Intl.DateTimeFormat("en-US", range === "24h"
    ? { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }
    : { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}
