"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Copy, ExternalLink, LogOut, RefreshCw, Share2, UserRound } from "lucide-react";
import { formatUnits, type Address } from "viem";
import { useAccount, useDisconnect, useReadContracts } from "wagmi";
import { useFactoryTokenIndex } from "@/hooks/use-factory-token-index";
import { arcTestnet, EXPLORER_URL } from "@/lib/chains";
import { erc20Abi } from "@/lib/contracts";
import type { TokenData, Trade } from "@/lib/types";
import { money, number, shortAddress, tickerLabel, utcDateTime } from "@/lib/utils";
import { Badge, Button, LinkButton, TokenIcon, WarningBox } from "@/components/ui";

type ProfileTab = "Positions" | "History" | "Activity" | "Launches";
type WalletTrade = { token: TokenData; trade: Trade };
type Position = {
  token: TokenData;
  balance: number;
  value: number;
  bought: number;
  sold: number;
  pnl: number | null;
};

const tabs: ProfileTab[] = ["Positions", "History", "Activity", "Launches"];

export function ProfileDashboard() {
  const { address, isConnected, chainId } = useAccount();
  const { disconnect } = useDisconnect();
  const { tokens, loading, error, refresh, isPartial } = useFactoryTokenIndex();
  const [activeTab, setActiveTab] = useState<ProfileTab>("Positions");
  const [actionMessage, setActionMessage] = useState("");
  const balanceReads = useReadContracts({
    contracts: tokens.map((token) => ({
      address: token.address as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address ?? "0x0000000000000000000000000000000000000000"],
      chainId: arcTestnet.id,
    })),
    query: {
      enabled: Boolean(address) && tokens.length > 0 && chainId === arcTestnet.id,
      staleTime: 10_000,
      refetchInterval: 15_000,
    },
    allowFailure: true,
  });

  const walletTrades = useMemo(() => {
    if (!address) return [];
    const normalized = address.toLowerCase();
    return tokens.flatMap((token) => token.recentTrades
      .filter((trade) => trade.wallet.toLowerCase() === normalized)
      .map((trade): WalletTrade => ({ token, trade })))
      .sort((left, right) => (right.trade.timestamp ?? 0) - (left.trade.timestamp ?? 0));
  }, [address, tokens]);

  const positions = useMemo(() => tokens.map((token, index): Position | null => {
    const rawBalance = balanceReads.data?.[index]?.result;
    if (typeof rawBalance !== "bigint" || rawBalance <= 0n) return null;
    const balance = Number(formatUnits(rawBalance, 18));
    const trades = walletTrades.filter((item) => item.token.address.toLowerCase() === token.address.toLowerCase());
    const bought = trades.filter(({ trade }) => trade.type === "Buy").reduce((sum, { trade }) => sum + trade.usdc, 0);
    const sold = trades.filter(({ trade }) => trade.type === "Sell").reduce((sum, { trade }) => sum + trade.usdc, 0);
    const tradedBalance = trades.reduce((sum, { trade }) => sum + (trade.type === "Buy" ? trade.tokens : -trade.tokens), 0);
    const reconciled = Math.abs(balance - Math.max(0, tradedBalance)) <= Math.max(0.000001, balance * 1e-9);
    const value = balance * token.price;
    return { token, balance, value, bought, sold, pnl: reconciled && bought > 0 ? sold + value - bought : null };
  }).filter((position): position is Position => Boolean(position)), [balanceReads.data, tokens, walletTrades]);

  const launches = useMemo(() => {
    if (!address) return [];
    return tokens.filter((token) => token.creator.toLowerCase() === address.toLowerCase())
      .sort((left, right) => (right.launchedAt ?? 0) - (left.launchedAt ?? 0));
  }, [address, tokens]);
  const portfolioValue = positions.reduce((sum, position) => sum + position.value, 0);
  const confirmedVolume = walletTrades.reduce((sum, { trade }) => sum + trade.usdc, 0);

  async function copyAddress() {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setActionMessage("Address copied");
  }

  async function shareProfile() {
    if (!address) return;
    const url = `${window.location.origin}/profile`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "ArcOrigin profile", text: address, url });
        return;
      } catch {
        return;
      }
    }
    await navigator.clipboard.writeText(url);
    setActionMessage("Profile link copied");
  }

  if (!isConnected || !address) return <div className="container-shell py-14">
    <div className="mx-auto max-w-xl rounded-2xl border border-line bg-panel p-8 text-center shadow-glow">
      <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-line bg-white/[.03] text-slate-300"><UserRound className="size-6" /></div>
      <h1 className="mt-5 text-2xl font-semibold tracking-[-.035em] text-white">Connect your wallet</h1>
      <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-slate-400">Connect from the header to view confirmed positions, trades, activity, and launches associated with your wallet.</p>
      <LinkButton href="/tokens" variant="secondary" className="mt-6">Explore tokens</LinkButton>
    </div>
  </div>;

  return <div className="container-shell py-8 md:py-12">
    <section className="overflow-hidden rounded-[22px] border border-line bg-panel shadow-glow">
      <div className="flex flex-col gap-5 border-b border-line p-5 sm:p-7 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <div className="grid size-14 shrink-0 place-items-center rounded-2xl border border-line bg-white/[.035] text-slate-200"><UserRound className="size-6" /></div>
          <div className="min-w-0">
            <h1 className="break-safe text-xl font-semibold tracking-[-.035em] text-white sm:text-2xl">{address}</h1>
            <p className="mt-1 text-sm text-slate-500">Your ArcOrigin profile</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={() => void copyAddress()}><Copy className="size-4" />Copy address</Button>
          <Button variant="secondary" onClick={() => void shareProfile()}><Share2 className="size-4" />Share</Button>
          <a href={`${EXPLORER_URL}/address/${address}`} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center justify-center gap-2 rounded-[10px] border border-line bg-white/[.035] px-4 text-[13px] font-semibold text-slate-100 transition hover:bg-white/[.06]">Arcscan <ExternalLink className="size-4" /></a>
          <Button variant="danger" onClick={() => disconnect()}><LogOut className="size-4" />Disconnect</Button>
        </div>
      </div>
      <div className="p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="text-sm text-slate-500">Confirmed portfolio value</p>
            <p className="mt-2 text-[42px] font-semibold leading-none tracking-[-.055em] text-white sm:text-[52px]">{balanceReads.isPending ? "—" : money(portfolioValue)}</p>
            <p className="mt-3 text-sm text-slate-500">Across {positions.length} open position{positions.length === 1 ? "" : "s"} · {money(confirmedVolume)} confirmed trade volume</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={isPartial ? "warn" : "good"}>{isPartial ? "Partial market data" : "Confirmed onchain"}</Badge>
            <Button variant="ghost" disabled={loading} onClick={() => {
              void refresh(true);
              void balanceReads.refetch();
            }}><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />Refresh</Button>
          </div>
        </div>
        <div className="relative mt-7 h-[210px] overflow-hidden rounded-2xl border border-line bg-black/15">
          <div className="absolute inset-0 opacity-60 grid-line" />
          <div className="absolute inset-x-5 bottom-10 border-t border-cyan/55">
            <span className="absolute -right-1 -top-1.5 size-3 rounded-full border-2 border-[#0a101a] bg-cyan shadow-[0_0_18px_rgba(57,189,248,.7)]" />
          </div>
          <div className="absolute bottom-4 left-5 right-5 flex items-center justify-between text-[11px] text-slate-600"><span>Current confirmed state</span><span>{money(portfolioValue)}</span></div>
          <p className="absolute left-5 top-5 max-w-md text-xs leading-5 text-slate-500">Historical portfolio valuation is not shown until a complete onchain price-history source is available.</p>
        </div>
      </div>
    </section>

    <section className="mt-5 overflow-hidden rounded-[22px] border border-line bg-panel shadow-glow">
      <div className="flex gap-1 overflow-x-auto border-b border-line px-4 pt-3 sm:px-6" role="tablist" aria-label="Profile data">
        {tabs.map((tab) => <button key={tab} type="button" role="tab" aria-selected={activeTab === tab} onClick={() => setActiveTab(tab)} className={activeTab === tab ? "border-b-2 border-cyan px-4 py-3 text-sm font-semibold text-white" : "border-b-2 border-transparent px-4 py-3 text-sm font-medium text-slate-500 transition hover:text-white"}>
          {tab}{tab === "Positions" && positions.length > 0 ? ` (${positions.length})` : tab === "History" && walletTrades.length > 0 ? ` (${walletTrades.length})` : tab === "Launches" && launches.length > 0 ? ` (${launches.length})` : ""}
        </button>)}
      </div>
      {activeTab === "Positions" && <PositionsTable positions={positions} loading={balanceReads.isPending} />}
      {activeTab === "History" && <HistoryTable trades={walletTrades} />}
      {activeTab === "Activity" && <ActivityFeed trades={walletTrades} launches={launches} />}
      {activeTab === "Launches" && <LaunchGrid tokens={launches} />}
      {error && <div className="px-5 pb-5"><WarningBox>{error}</WarningBox></div>}
      {actionMessage && <p className="border-t border-line px-6 py-3 text-xs text-emerald-300">{actionMessage}</p>}
    </section>
  </div>;
}

function PositionsTable({ positions, loading }: { positions: Position[]; loading: boolean }) {
  if (loading) return <EmptyPanel title="Reading token balances…" body="Balances are being read directly from each token contract." />;
  if (positions.length === 0) return <EmptyPanel title="No open positions" body="No positive balance was found in the currently indexed ArcOrigin tokens." action />;
  return <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm">
    <thead><tr className="border-b border-line text-[10px] uppercase tracking-[.08em] text-slate-600"><th className="px-6 py-3">Token</th><th>Balance</th><th>Value</th><th>Bought</th><th>Sold</th><th>PnL</th><th className="pr-6 text-right">Action</th></tr></thead>
    <tbody>{positions.map((position) => <tr key={position.token.address} className="border-b border-line/70 last:border-0 hover:bg-white/[.02]">
      <td className="px-6 py-4"><TokenLabel token={position.token} /></td>
      <td className="text-slate-300">{number(position.balance)}</td><td className="font-medium text-white">{money(position.value)}</td><td className="text-emerald-300">{money(position.bought)}</td><td className="text-rose-300">{money(position.sold)}</td>
      <td className={position.pnl === null ? "text-slate-600" : position.pnl >= 0 ? "text-emerald-300" : "text-rose-300"}>{position.pnl === null ? "—" : `${position.pnl >= 0 ? "+" : ""}${money(position.pnl)}`}</td>
      <td className="pr-6 text-right"><Link href={`/tokens/${position.token.address}`} className="font-semibold text-cyan hover:underline">Trade</Link></td>
    </tr>)}</tbody>
  </table><p className="border-t border-line px-6 py-3 text-[11px] leading-5 text-slate-500">PnL is shown only when the actual ERC-20 balance reconciles with confirmed curve trades. Transfers can make cost basis unavailable.</p></div>;
}

function HistoryTable({ trades }: { trades: WalletTrade[] }) {
  if (trades.length === 0) return <EmptyPanel title="No confirmed trades" body="Wallet buys and sells will appear here after their Arc Testnet transaction is confirmed." action />;
  return <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-sm">
    <thead><tr className="border-b border-line text-[10px] uppercase tracking-[.08em] text-slate-600"><th className="px-6 py-3">Time</th><th>Token</th><th>Type</th><th>USDC</th><th>Tokens</th><th className="pr-6 text-right">Transaction</th></tr></thead>
    <tbody>{trades.map(({ token, trade }) => <tr key={`${token.address}-${trade.txHash}`} className="border-b border-line/70 last:border-0 hover:bg-white/[.02]">
      <td className="px-6 py-4 text-xs text-slate-500">{utcDateTime(trade.timestamp)}</td><td><TokenLabel token={token} compact /></td><td className={trade.type === "Buy" ? "text-emerald-300" : "text-rose-300"}>{trade.type}</td><td className="text-white">{money(trade.usdc)}</td><td className="text-slate-300">{number(trade.tokens)}</td>
      <td className="pr-6 text-right"><a href={`${EXPLORER_URL}/tx/${trade.txHash}`} target="_blank" rel="noreferrer" className="text-cyan hover:underline">{shortAddress(trade.txHash)}</a></td>
    </tr>)}</tbody>
  </table></div>;
}

function ActivityFeed({ trades, launches }: { trades: WalletTrade[]; launches: TokenData[] }) {
  const items = [
    ...trades.map(({ token, trade }) => ({ key: trade.txHash, timestamp: trade.timestamp ?? 0, title: `${trade.type === "Buy" ? "Bought" : "Sold"} ${tickerLabel(token.ticker)}`, detail: `${money(trade.usdc)} · ${number(trade.tokens)} tokens`, href: `${EXPLORER_URL}/tx/${trade.txHash}`, token })),
    ...launches.map((token) => ({ key: token.launchTxHash ?? token.address, timestamp: token.launchedAt ?? 0, title: `Launched ${tickerLabel(token.ticker)}`, detail: token.name, href: `/tokens/${token.address}`, token })),
  ].sort((left, right) => right.timestamp - left.timestamp);
  if (items.length === 0) return <EmptyPanel title="No wallet activity" body="Confirmed trades and token launches from this wallet will appear here." action />;
  return <div className="divide-y divide-line/70">{items.map((item) => <a key={`${item.key}-${item.title}`} href={item.href} target={item.href.startsWith("http") ? "_blank" : undefined} rel={item.href.startsWith("http") ? "noreferrer" : undefined} className="flex items-center gap-4 px-6 py-4 transition hover:bg-white/[.02]">
    <TokenIcon label={item.token.icon} image={item.token.image} className="size-10 rounded-xl" />
    <div className="min-w-0 flex-1"><p className="font-semibold text-white">{item.title}</p><p className="mt-1 truncate text-xs text-slate-500">{item.detail}</p></div>
    <p className="shrink-0 text-xs text-slate-500">{utcDateTime(item.timestamp)}</p><ExternalLink className="size-4 shrink-0 text-slate-600" />
  </a>)}</div>;
}

function LaunchGrid({ tokens }: { tokens: TokenData[] }) {
  if (tokens.length === 0) return <EmptyPanel title="No launches from this wallet" body="Tokens created from this address will appear here after the factory transaction is confirmed." />;
  return <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">{tokens.map((token) => <Link key={token.address} href={`/tokens/${token.address}`} className="rounded-2xl border border-line bg-black/15 p-4 transition hover:border-cyan/25 hover:bg-white/[.025]">
    <div className="flex items-center gap-3"><TokenIcon label={token.icon} image={token.image} className="size-12 rounded-xl" /><div className="min-w-0"><p className="truncate font-semibold text-white">{token.name}</p><p className="mt-1 font-mono text-xs text-slate-500">{tickerLabel(token.ticker)}</p></div></div>
    <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-xs"><span className="text-slate-500">{utcDateTime(token.launchedAt)}</span><span className="text-slate-300">{money(token.marketCap, true)} MC</span></div>
  </Link>)}</div>;
}

function TokenLabel({ token, compact = false }: { token: TokenData; compact?: boolean }) {
  return <div className="flex items-center gap-3"><TokenIcon label={token.icon} image={token.image} className={compact ? "size-8 rounded-lg" : "size-10 rounded-xl"} /><div className="min-w-0"><p className="truncate font-semibold text-white">{token.name}</p><p className="mt-0.5 font-mono text-[10px] text-slate-500">{tickerLabel(token.ticker)}</p></div></div>;
}

function EmptyPanel({ title, body, action = false }: { title: string; body: string; action?: boolean }) {
  return <div className="px-6 py-12 text-center"><p className="font-semibold text-white">{title}</p><p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-500">{body}</p>{action && <LinkButton href="/tokens" className="mt-5">Explore tokens</LinkButton>}</div>;
}
