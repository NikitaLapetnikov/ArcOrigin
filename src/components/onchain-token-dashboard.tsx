"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useAccount } from "wagmi";
import { PnlShareCard } from "@/components/pnl-share-card";
import { KLineTokenChart } from "@/components/kline-token-chart";
import { AddressPill, ArcscanLink, Badge, Button, Panel, Progress, TokenIcon, WarningBox } from "@/components/ui";
import { useHolderSnapshot } from "@/hooks/use-holder-snapshot";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { EXPLORER_URL, arcChain } from "@/lib/chains";
import { loadIndexedMarketSnapshot } from "@/lib/onchain/market-event-snapshot";
import type { MarketSnapshot } from "@/lib/onchain/market-snapshot";
import type { HolderSnapshot } from "@/lib/onchain/holder-snapshot";
import { snapshotRevalidationDelay } from "@/lib/onchain/snapshot-revalidation";
import type { TokenData, Trade } from "@/lib/types";
import { money, number, tickerLabel } from "@/lib/utils";

export type OnchainTokenSnapshot = MarketSnapshot;
type TerminalTab = "Trades" | "My position" | "Top traders" | "Holders" | "Market";
const MARKET_POLL_INTERVAL_MS = 5_000;

type TraderSummary = {
  wallet: string;
  boughtUsdc: number;
  soldUsdc: number;
  boughtTokens: number;
  soldTokens: number;
  buys: number;
  sells: number;
};

function createIndexedFallback(token: TokenData): OnchainTokenSnapshot {
  const totalSupply = token.totalSupply ?? 1_000_000_000;
  return {
    price: token.price,
    priceChange: token.priceChange24h,
    marketCap: token.marketCap,
    volume: token.volume24h,
    buyers: token.buyers,
    sellers: token.sellers,
    raisedUsdc: token.marketCap,
    targetUsdc: token.targetUSDC,
    progress: token.crossProgress,
    crossed: token.status === "Crossed",
    tokensSold: 0,
    tokenReserve: totalSupply,
    chart: token.chartData.length > 0 ? token.chartData : [{ time: "Launch", price: token.price, volume: 0 }],
    trades: token.recentTrades,
    indexedBlock: String(token.launchBlock ?? "Factory"),
    generatedAt: new Date().toISOString(),
  };
}

function numericBlock(value: string) {
  return /^\d+$/.test(value) ? BigInt(value) : null;
}

export function useOnchainTokenSnapshot(token: TokenData) {
  const [snapshot, setSnapshot] = useState<OnchainTokenSnapshot>(() => createIndexedFallback(token));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const pendingTradeHashes = useRef(new Set<string>());
  const refreshRequestRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const staleRevalidationAttemptRef = useRef(0);

  const applyRefreshedSnapshot = useCallback((next: OnchainTokenSnapshot) => {
    setSnapshot((current) => {
      const currentBlock = numericBlock(current.indexedBlock);
      const nextBlock = numericBlock(next.indexedBlock);
      if (currentBlock !== null && nextBlock !== null && nextBlock < currentBlock) return current;
      for (const hash of pendingTradeHashes.current) {
        if (!next.trades.some((trade) => trade.txHash.toLowerCase() === hash)) return current;
        pendingTradeHashes.current.delete(hash);
      }
      return next;
    });
  }, []);

  const refresh = useCallback(async (forceRefresh = false, background = false) => {
    if (background && refreshInFlightRef.current) return;
    const requestId = ++refreshRequestRef.current;
    refreshInFlightRef.current = true;
    const isCurrentRequest = () => refreshRequestRef.current === requestId;
    if (!background) setLoading(true);
    try {
      try {
        const response = await fetch(`/api/onchain/tokens/${token.address}/market${forceRefresh ? "?refresh=1" : ""}`, {
          cache: forceRefresh ? "no-store" : "default",
          signal: AbortSignal.timeout(12_000),
        });
        const payload = await response.json() as { snapshot?: OnchainTokenSnapshot; stale?: boolean; error?: string };
        if (!response.ok || !payload.snapshot) throw new Error(payload.error ?? "Market data is unavailable.");
        if (!isCurrentRequest()) return;
        applyRefreshedSnapshot(payload.snapshot);
        setStale(Boolean(payload.stale));
        setError("");
      } catch {
        const fallback = await loadIndexedMarketSnapshot(token);
        if (!isCurrentRequest()) return;
        applyRefreshedSnapshot(fallback);
        setStale(false);
        setError("");
      }
    } catch (loadError) {
      if (!isCurrentRequest()) return;
      setStale(true);
      const message = loadError instanceof Error ? loadError.message : "Live market data could not be loaded.";
      setError(`Showing the latest Factory snapshot. ${message}`);
    } finally {
      if (isCurrentRequest()) {
        refreshInFlightRef.current = false;
        if (!background) setLoading(false);
      }
    }
  }, [applyRefreshedSnapshot, token]);

  useLiveRefresh({
    intervalMs: MARKET_POLL_INTERVAL_MS,
    refresh: () => refresh(false, true),
  });

  useEffect(() => {
    if (!stale) {
      staleRevalidationAttemptRef.current = 0;
      return;
    }
    if (loading) return;
    const attempt = staleRevalidationAttemptRef.current;
    const timer = window.setTimeout(() => {
      staleRevalidationAttemptRef.current = attempt + 1;
      void refresh(false);
    }, snapshotRevalidationDelay(attempt));
    return () => window.clearTimeout(timer);
  }, [loading, refresh, stale]);

  useEffect(() => {
    void refresh();
    const retryTimers: Array<ReturnType<typeof setTimeout>> = [];
    const handleTrade = (event: Event) => {
      const detail = (event as CustomEvent<{
        tokenAddress?: string;
        transactionHash?: string;
        side?: "Buy" | "Sell";
        wallet?: string;
        blockNumber?: string;
        timestamp?: number;
        usdc?: number;
        fee?: number;
        tokens?: number;
      }>).detail;
      if (detail?.tokenAddress?.toLowerCase() !== token.address.toLowerCase()
        || !detail.transactionHash
        || !detail.side
        || !detail.wallet
        || !detail.usdc
        || !detail.tokens) return;
      const hash = detail.transactionHash.toLowerCase();
      const side = detail.side;
      const wallet = detail.wallet;
      const transactionHash = detail.transactionHash;
      const usdc = detail.usdc;
      const tokens = detail.tokens;
      pendingTradeHashes.current.add(hash);
      setSnapshot((current) => {
        if (current.trades.some((trade) => trade.txHash.toLowerCase() === hash)) return current;
        const timestamp = detail.timestamp ?? Math.floor(Date.now() / 1_000);
        const price = usdc / tokens;
        const totalSupply = token.totalSupply ?? 1_000_000_000;
        const marketCap = price * totalSupply;
        const trade: Trade = {
            time: detail.blockNumber ? `Block ${detail.blockNumber}` : "Confirmed",
            timestamp,
            type: side,
            wallet,
            usdc,
            tokens,
            price,
            txHash: transactionHash,
          };
        return {
            ...current,
            price,
            priceChange: token.price > 0 ? (price / token.price - 1) * 100 : current.priceChange,
            marketCap,
            volume: current.volume + usdc,
            buyers: current.buyers + (side === "Buy" ? 1 : 0),
            sellers: current.sellers + (side === "Sell" ? 1 : 0),
            raisedUsdc: marketCap,
            progress: current.targetUsdc > 0 ? Math.min(100, marketCap / current.targetUsdc * 100) : 0,
            crossed: current.crossed || marketCap >= current.targetUsdc,
            tokensSold: Math.max(0, current.tokensSold + (side === "Buy" ? tokens : -tokens)),
            tokenReserve: Math.max(0, current.tokenReserve + (side === "Buy" ? -tokens : tokens)),
            chart: [...current.chart, { time: "Now", timestamp, price, volume: usdc }],
            trades: [trade, ...current.trades],
            generatedAt: new Date().toISOString(),
        };
      });
      for (const delay of [1_500, 5_000, 12_000]) {
        retryTimers.push(setTimeout(() => void refresh(true), delay));
      }
    };
    window.addEventListener("arcforge:trade-confirmed", handleTrade);
    return () => {
      window.removeEventListener("arcforge:trade-confirmed", handleTrade);
      retryTimers.forEach(clearTimeout);
    };
  }, [refresh, token.address, token.price, token.totalSupply]);

  return { snapshot, loading, error, stale, refresh };
}

export function OnchainTokenDashboard({
  token,
  initialHolderSnapshot,
  rightRail,
}: {
  token: TokenData;
  initialHolderSnapshot?: HolderSnapshot | null;
  rightRail?: React.ReactNode;
}) {
  const { snapshot, loading, error, stale, refresh } = useOnchainTokenSnapshot(token);
  const [activeTab, setActiveTab] = useState<TerminalTab>("Trades");
  const { address } = useAccount();
  const {
    snapshot: holderSnapshot,
    loading: holderLoading,
    error: holderError,
    refresh: refreshHolders,
  } = useHolderSnapshot(
    token,
    activeTab === "Holders" || activeTab === "My position",
    initialHolderSnapshot,
  );

  const remainingToCross = Math.max(0, token.targetUSDC - snapshot.raisedUsdc);
  const progressLabel = snapshot.progress > 0 && snapshot.progress < 0.01 ? "<0.01%" : `${snapshot.progress.toFixed(2)}%`;
  const cutoff24h = Math.floor(Date.now() / 1_000) - 24 * 60 * 60;
  const recentTrades = snapshot.trades.filter((trade) => (trade.timestamp ?? 0) >= cutoff24h);
  const buyTrades = recentTrades.filter((trade) => trade.type === "Buy");
  const sellTrades = recentTrades.filter((trade) => trade.type === "Sell");
  const buyVolume = buyTrades.reduce((sum, trade) => sum + trade.usdc, 0);
  const sellVolume = sellTrades.reduce((sum, trade) => sum + trade.usdc, 0);
  const totalFlow = buyVolume + sellVolume;
  const buyShare = totalFlow > 0 ? buyVolume / totalFlow * 100 : 50;
  const netFlow = buyVolume - sellVolume;
  const traderSummaries = useMemo(() => summarizeTraders(snapshot.trades), [snapshot.trades]);
  const walletTrades = useMemo(
    () => address ? snapshot.trades.filter((trade) => trade.wallet.toLowerCase() === address.toLowerCase()) : [],
    [address, snapshot.trades],
  );
  const walletHolder = address
    ? holderSnapshot?.topHolders.find((holder) => holder.address.toLowerCase() === address.toLowerCase())
    : undefined;
  const walletBought = walletTrades.filter((trade) => trade.type === "Buy").reduce((sum, trade) => sum + trade.usdc, 0);
  const walletSold = walletTrades.filter((trade) => trade.type === "Sell").reduce((sum, trade) => sum + trade.usdc, 0);
  const walletTradeTokens = walletTrades.reduce(
    (sum, trade) => sum + (trade.type === "Buy" ? trade.tokens : -trade.tokens),
    0,
  );
  const walletBalance = walletHolder ? Number(walletHolder.balance) : 0;
  const walletBalanceMatchesTrades = Boolean(walletHolder)
    && Math.abs(walletBalance - Math.max(0, walletTradeTokens)) <= Math.max(0.000001, walletBalance * 1e-9);
  const walletValue = walletBalance * snapshot.price;
  const walletPnl = walletBalanceMatchesTrades && walletBought > 0
    ? walletSold + walletValue - walletBought
    : null;
  const tabs: Array<{ label: TerminalTab; count?: string }> = [
    { label: "Trades", count: String(snapshot.trades.length) },
    { label: "My position", count: address && walletHolder ? "1" : undefined },
    { label: "Top traders", count: traderSummaries.length > 0 ? String(traderSummaries.length) : undefined },
    { label: "Holders", count: holderSnapshot ? number(holderSnapshot.holders) : token.holders > 0 ? number(token.holders) : undefined },
    { label: "Market" },
  ];

  return <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px] 2xl:grid-cols-[minmax(0,1fr)_380px]">
    <Panel className="min-w-0 overflow-hidden rounded-[28px] shadow-none">
    <div className="flex flex-wrap items-center gap-x-10 gap-y-4 border-b border-line/70 px-5 py-4 sm:px-6">
      <TerminalMetric label="Price" value={tokenPrice(snapshot.price)} />
      <TerminalMetric label="Market cap" value={money(snapshot.marketCap, true)} />
      <TerminalMetric label="Supply" value={token.totalSupply ? number(token.totalSupply) : "—"} />
      <TerminalMetric label="Holders" value={holderSnapshot ? number(holderSnapshot.holders) : token.holders > 0 ? number(token.holders) : "—"} />
      <TerminalMetric
        label="Since launch"
        value={`${snapshot.priceChange >= 0 ? "+" : ""}${snapshot.priceChange.toFixed(2)}%`}
        tone={snapshot.priceChange >= 0 ? "good" : "bad"}
      />
    </div>

    <div className="border-b border-line/70 p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={loading || stale ? "neutral" : "good"}>{loading ? "Refreshing" : stale ? "Cached" : "Live"}</Badge>
          <span className="font-mono text-[9px] text-slate-600">Block {snapshot.indexedBlock}</span>
        </div>
        <div className="flex items-center gap-1">
          <PnlShareCard token={token} snapshot={snapshot} />
          <Button variant="ghost" className="h-8 px-2.5 text-xs" disabled={loading} onClick={() => void refresh(true)}>
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />Refresh
          </Button>
        </div>
      </div>
      <KLineTokenChart
        data={snapshot.chart}
        trades={walletTrades}
        tokenName={token.name}
        ticker={token.ticker}
        tokenAddress={token.address}
        totalSupply={token.totalSupply}
      />
      {error && <div className="mt-3"><WarningBox>{error}</WarningBox></div>}
    </div>

    <div className="flex items-center justify-between gap-3 border-b border-line/70 pr-4">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto px-2">
        {tabs.map((tab) => <button
          key={tab.label}
          type="button"
          onClick={() => setActiveTab(tab.label)}
          className={`relative flex h-11 shrink-0 items-center gap-2 px-3 text-xs font-medium transition ${activeTab === tab.label ? "bg-white/[.025] text-white" : "text-slate-500 hover:text-slate-300"}`}
        >
          {tab.label}
          {tab.count && <span className="font-mono text-[9px] text-slate-600">{tab.count}</span>}
          {activeTab === tab.label && <span className="absolute inset-x-3 bottom-0 h-px bg-cyan" />}
        </button>)}
      </div>
      <span className="hidden shrink-0 font-mono text-[8px] uppercase tracking-wider text-slate-700 2xl:block">Uniswap V3 · LP locked forever</span>
    </div>

    <div className="min-h-[260px]">
      {activeTab === "Trades" && <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead><tr className="border-b border-line font-mono text-[9px] uppercase tracking-wider text-slate-600"><th className="px-4 py-3">Block</th><th>Type</th><th>Wallet</th><th>USDC</th><th>Tokens</th><th>Price</th><th>Transaction</th></tr></thead>
          <tbody>{snapshot.trades.map((trade) => <tr key={trade.txHash} className="border-b border-line/60 last:border-0 hover:bg-white/[.02]"><td className="px-4 py-3 text-slate-500">{trade.time}</td><td><Badge tone={trade.type === "Buy" ? "good" : "bad"}>{trade.type}</Badge></td><td><AddressPill address={trade.wallet}/></td><td className={trade.type === "Buy" ? "text-emerald-300" : "text-rose-300"}>{money(trade.usdc)}</td><td className="text-slate-300">{number(trade.tokens)}</td><td className="text-slate-400">{tokenPrice(trade.price)}</td><td><ArcscanLink hash={trade.txHash}/></td></tr>)}
          {snapshot.trades.length === 0 && <tr><td colSpan={7} className="px-5 py-12 text-center text-sm text-slate-500">No confirmed trades yet. The first buy will appear here onchain.</td></tr>}</tbody>
        </table>
      </div>}

      {activeTab === "My position" && <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="eyebrow">Connected wallet</p>
            <p className="mt-2 text-sm text-slate-400">Actual token balance from confirmed ERC-20 Transfer events; trade totals include confirmed Uniswap V3 swaps only.</p>
          </div>
          {address && <AddressPill address={address}/>}
        </div>
        {!address && <TerminalEmpty title="Connect a wallet to view your position" body="ArcOrigin will show this wallet's confirmed balance and pool trades without estimating missing data."/>}
        {address && holderLoading && !holderSnapshot && <TerminalEmpty title="Loading your position…" body="Reading the confirmed holder snapshot in the background."/>}
        {address && holderSnapshot && !walletHolder && <TerminalEmpty title="No current token balance found" body="This wallet is not present in the confirmed holder snapshot for this token."/>}
        {address && walletHolder && <div className="mt-5 overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[850px] text-left text-xs">
            <thead><tr className="border-b border-line bg-black/15 font-mono text-[9px] uppercase tracking-wider text-slate-600"><th className="px-4 py-3">Token</th><th>Actual balance</th><th>Current value</th><th>Bought</th><th>Sold</th><th>Estimated PnL</th><th className="pr-4 text-right">Action</th></tr></thead>
            <tbody><tr>
              <td className="px-4 py-4"><div className="flex items-center gap-3"><TokenIcon label={token.icon} image={token.image} className="size-8 rounded-lg"/><div><p className="font-semibold text-white">{tickerLabel(token.ticker)}</p><p className="mt-0.5 text-[9px] text-slate-600">{arcChain.name}</p></div></div></td>
              <td className="text-slate-200">{formatTokenAmount(walletBalance)}</td>
              <td className="text-slate-200">{money(walletValue)}</td>
              <td className="text-emerald-300">{money(walletBought)}</td>
              <td className="text-rose-300">{money(walletSold)}</td>
              <td className={walletPnl === null ? "text-slate-600" : walletPnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{walletPnl === null ? "—" : `${walletPnl >= 0 ? "+" : ""}${money(walletPnl)}`}</td>
              <td className="pr-4 text-right"><Button variant="secondary" className="h-8 rounded-lg px-3 text-xs" onClick={scrollToTradePanel}>Trade</Button></td>
            </tr></tbody>
          </table>
        </div>}
        {address && walletHolder && walletPnl === null && <p className="mt-3 text-[11px] leading-5 text-slate-500">PnL is unavailable because the actual wallet balance does not match net pool trades. This usually means tokens were transferred; ArcOrigin does not invent a cost basis.</p>}
        {holderError && <div className="mt-4"><WarningBox>{holderError}</WarningBox></div>}
      </div>}

      {activeTab === "Top traders" && <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-xs">
          <thead><tr className="border-b border-line font-mono text-[9px] uppercase tracking-wider text-slate-600"><th className="px-4 py-3">#</th><th>Trader</th><th>Bought</th><th>Sold</th><th>Net USDC</th><th>Tokens bought</th><th>Tokens sold</th><th>Txns</th><th>Explorer</th></tr></thead>
          <tbody>{traderSummaries.map((trader, index) => {
            const netUsdc = trader.soldUsdc - trader.boughtUsdc;
            return <tr key={trader.wallet} className="border-b border-line/60 last:border-0 hover:bg-white/[.02]">
              <td className="px-4 py-3 font-mono text-slate-600">{index + 1}</td>
              <td><AddressPill address={trader.wallet}/></td>
              <td className="text-emerald-300">{money(trader.boughtUsdc)}</td>
              <td className="text-rose-300">{money(trader.soldUsdc)}</td>
              <td className={netUsdc >= 0 ? "text-emerald-300" : "text-rose-300"}>{netUsdc >= 0 ? "+" : ""}{money(netUsdc)}</td>
              <td className="text-slate-400">{formatTokenAmount(trader.boughtTokens)}</td>
              <td className="text-slate-400">{formatTokenAmount(trader.soldTokens)}</td>
              <td className="text-slate-300">{trader.buys + trader.sells}</td>
              <td><a href={`${EXPLORER_URL}/address/${trader.wallet}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-cyan hover:underline">Open <ExternalLink className="size-3"/></a></td>
            </tr>;
          })}
          {traderSummaries.length === 0 && <tr><td colSpan={9} className="px-5 py-12 text-center text-sm text-slate-500">No confirmed traders yet.</td></tr>}</tbody>
        </table>
        {traderSummaries.length > 0 && <p className="border-t border-line px-4 py-3 text-[10px] leading-5 text-slate-600">Ranked by confirmed buy + sell volume. Net USDC is cash flow, not profit, because transferred tokens can change cost basis.</p>}
      </div>}

      {activeTab === "Holders" && <div className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="eyebrow">Holder distribution</p><p className="mt-2 text-sm text-slate-400">Confirmed holder balances, cached locally for instant repeat visits.</p></div><div className="flex items-center gap-2"><Badge tone={holderSnapshot ? "good" : "neutral"}>{holderLoading ? "Refreshing" : holderSnapshot ? "Ready" : "Unavailable"}</Badge><Button variant="ghost" className="h-8 px-2.5 text-xs" disabled={holderLoading} onClick={() => void refreshHolders(true)}>Refresh</Button></div></div>
        {holderLoading && !holderSnapshot && <div className="mt-8 rounded-xl border border-line bg-black/15 px-4 py-10 text-center text-sm text-slate-500">Loading holder analytics in the background…</div>}
        {holderSnapshot && <div className="mt-6 grid gap-5 sm:grid-cols-3">{[["Creator", holderSnapshot.creatorPercent], ["Top 10 excluding pool", holderSnapshot.topTenExcludingPoolPercent], ["Uniswap V3 pool", holderSnapshot.poolPercent]].map(([label, value]) => <div key={String(label)} className="rounded-xl border border-line bg-black/15 p-4"><div className="mb-3 flex justify-between text-xs"><span className="text-slate-500">{label}</span><span className="text-slate-200">{Number(value).toFixed(2)}%</span></div><Progress value={Number(value)}/></div>)}</div>}
        {holderSnapshot && <div className="mt-5 overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[700px] text-left text-xs">
            <thead><tr className="border-b border-line bg-black/15 font-mono text-[9px] uppercase tracking-wider text-slate-600"><th className="px-4 py-3">#</th><th>Holder</th><th>Balance</th><th>Supply share</th><th>Role</th><th>Explorer</th></tr></thead>
            <tbody>{holderSnapshot.topHolders.map((holder, index) => <tr key={holder.address} className="border-b border-line/60 last:border-0 hover:bg-white/[.02]">
              <td className="px-4 py-3 font-mono text-slate-600">{index + 1}</td>
              <td><AddressPill address={holder.address}/></td>
              <td className="text-slate-200">{formatTokenAmount(Number(holder.balance))}</td>
              <td><div className="w-32"><div className="mb-1 flex justify-between"><span className="text-slate-300">{holder.percent.toFixed(2)}%</span></div><Progress value={holder.percent}/></div></td>
              <td><Badge tone={holder.role === "Pool" ? "cyan" : holder.role === "Creator" ? "warn" : "neutral"}>{holder.role}</Badge></td>
              <td><a href={`${EXPLORER_URL}/address/${holder.address}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-cyan hover:underline">Open <ExternalLink className="size-3"/></a></td>
            </tr>)}</tbody>
          </table>
        </div>}
        {holderError && <div className="mt-4"><WarningBox>{holderError}</WarningBox></div>}
      </div>}

      {activeTab === "Market" && <div className="p-5">
        <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow">Locked Uniswap V3</p><h2 className="mt-2 text-lg font-semibold text-white">{snapshot.crossed ? "Crossed · liquidity unchanged" : `${progressLabel} toward crossed`}</h2></div><div className="text-right"><p className="text-sm text-white">{money(snapshot.raisedUsdc)} / {money(token.targetUSDC)}</p><p className="mt-1 text-xs text-slate-500">Market cap</p></div></div>
        <div className="my-5"><Progress value={snapshot.progress}/></div>
        <div className="grid grid-cols-2 gap-4 text-xs md:grid-cols-4"><Metric label="Tokens sold" value={number(snapshot.tokensSold)}/><Metric label="Pool inventory" value={number(snapshot.tokenReserve)}/><Metric label="To crossed" value={money(remainingToCross)}/><Metric label="LP custody" value="Locked forever"/></div>
        <p className="mt-5 border-t border-line pt-4 text-[11px] leading-5 text-slate-500">The pool and single-sided LP position exist from launch. Reaching $50k only records the permanent Crossed status; liquidity does not migrate or unlock.</p>
      </div>}

    </div>
    </Panel>
    <aside className="grid h-fit min-w-0 gap-4 xl:sticky xl:top-[76px]">
      <MarketFlowPanel
        buyVolume={buyVolume}
        sellVolume={sellVolume}
        buyCount={buyTrades.length}
        sellCount={sellTrades.length}
        buyShare={buyShare}
        netFlow={netFlow}
      />
      {rightRail}
    </aside>
  </div>;
}

function tokenPrice(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 0.000001) return `$${value.toFixed(10)}`;
  if (value < 0.01) return `$${value.toFixed(8)}`;
  return money(value);
}

function summarizeTraders(trades: Trade[]): TraderSummary[] {
  const traders = new Map<string, TraderSummary>();
  for (const trade of trades) {
    const key = trade.wallet.toLowerCase();
    const current = traders.get(key) ?? {
      wallet: trade.wallet,
      boughtUsdc: 0,
      soldUsdc: 0,
      boughtTokens: 0,
      soldTokens: 0,
      buys: 0,
      sells: 0,
    };
    if (trade.type === "Buy") {
      current.boughtUsdc += trade.usdc;
      current.boughtTokens += trade.tokens;
      current.buys += 1;
    } else {
      current.soldUsdc += trade.usdc;
      current.soldTokens += trade.tokens;
      current.sells += 1;
    }
    traders.set(key, current);
  }
  return [...traders.values()].sort(
    (left, right) => right.boughtUsdc + right.soldUsdc - left.boughtUsdc - left.soldUsdc,
  );
}

function scrollToTradePanel() {
  document.getElementById("trade-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function formatTokenAmount(value: number) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000) return number(value);
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function TerminalEmpty({ title, body }: { title: string; body: string }) {
  return <div className="mt-6 rounded-xl border border-line bg-black/15 px-5 py-12 text-center"><p className="text-sm font-medium text-slate-300">{title}</p><p className="mx-auto mt-2 max-w-xl text-xs leading-5 text-slate-600">{body}</p></div>;
}

function TerminalMetric({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: "good" | "bad" }) {
  return <div className="min-w-[112px]"><p className="text-[10px] font-medium uppercase tracking-[.08em] text-slate-600">{label}</p><p className={`mt-1 truncate text-[15px] font-semibold ${tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-white"}`}>{value}</p>{detail && <p className="mt-0.5 truncate text-[9px] text-slate-600">{detail}</p>}</div>;
}

function MarketFlowPanel({
  buyVolume,
  sellVolume,
  buyCount,
  sellCount,
  buyShare,
  netFlow,
}: {
  buyVolume: number;
  sellVolume: number;
  buyCount: number;
  sellCount: number;
  buyShare: number;
  netFlow: number;
}) {
  return <section className="px-1 py-1">
    <div className="grid grid-cols-4 gap-3">
      <FlowMetric label="24h volume" value={money(buyVolume + sellVolume, true)} />
      <FlowMetric label="Buys" value={money(buyVolume, true)} tone="good" detail={String(buyCount)} />
      <FlowMetric label="Sells" value={money(sellVolume, true)} tone="bad" detail={String(sellCount)} />
      <FlowMetric label="Net flow" value={`${netFlow >= 0 ? "+" : "−"}${money(Math.abs(netFlow), true)}`} tone={netFlow >= 0 ? "good" : "bad"} />
    </div>
    <div className="mt-3 flex h-1 overflow-hidden rounded-full bg-white/[.04]">
      <div className="bg-emerald-400" style={{ width: `${buyShare}%` }} />
      <div className="bg-rose-400" style={{ width: `${100 - buyShare}%` }} />
    </div>
  </section>;
}

function FlowMetric({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: "good" | "bad" }) {
  return <div className="min-w-0 py-1 text-center">
    <p className="truncate text-[9px] font-medium uppercase tracking-[.07em] text-slate-600">{label}</p>
    <p className={`mt-1 truncate text-[13px] font-semibold ${tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-slate-200"}`}>{value}</p>
    {detail && <p className="mt-0.5 text-[9px] text-slate-600">{detail} trades</p>}
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-slate-600">{label}</p><p className="mt-1 font-medium text-slate-200">{value}</p></div>;
}
