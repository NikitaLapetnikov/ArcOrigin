"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { decodeEventLog, formatUnits, parseUnits, publicActions, zeroAddress, type Address, type Hash, type PublicClient } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient, useWriteContract } from "wagmi";
import { ARC_ACTIVE_CONTRACTS, ARC_UNISWAP_V3, arcChain } from "@/lib/chains";
import { erc20Abi, uniswapV3FactoryAbi, uniswapV3PoolAbi, uniswapV3QuoterAbi, uniswapV3RouterAbi } from "@/lib/contracts";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import type { TokenData } from "@/lib/types";
import { tickerLabel } from "@/lib/utils";
import { ArcscanLink, Badge, Button } from "./ui";

type Side = "Buy" | "Sell";
type Priority = "Low" | "Medium" | "High";
type LiveQuote = { input: bigint; output: bigint; fee: bigint; minimumOutput: bigint; spender: Address; pool: Address };
type QuoteResponse = { output?: string; fee?: string; spender?: string; pool?: string; error?: string };
type TransactionStatus = "idle" | "quoting" | "preparing" | "approving" | "trading";
type WalletBalances = { usdc: bigint; token: bigint };
type TransactionFeeOverrides = { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint };
const percentageOptions = [10, 25, 50, 75, 100] as const;
const slippageOptions = [10, 20, 40] as const;
const priorityOptions: Priority[] = ["Low", "Medium", "High"];
const MAX_SLIPPAGE_PERCENT = 50;
const BALANCE_POLL_INTERVAL_MS = 10_000;
const QUOTE_POLL_INTERVAL_MS = 5_000;
const ARC_WALLET_RPC_URL = arcChain.rpcUrls.default.http[0];

function wait(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function withRpcRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/RPC Request failed|HTTP request failed|fetch failed|Too Many Requests|rate limit|timeout|network error|socket|\b429\b|\b50[234]\b/i.test(message) || attempt === attempts) throw error;
      await wait(attempt * 750);
    }
  }
  throw new Error("Arc RPC request failed after retries.");
}

function transactionError(error: unknown) {
  const message = typeof error === "object" && error && "shortMessage" in error ? String(error.shortMessage) : error instanceof Error ? error.message : "The wallet transaction failed.";
  if (isUnauthorizedBlockdaemonRpc(error)) return `Your wallet still uses the retired Blockdaemon Arc RPC. Open wallet settings → Networks → Arc and set the RPC URL to ${ARC_WALLET_RPC_URL}, then retry.`;
  if (/RPC Request failed|HTTP request failed|fetch failed|Too Many Requests|\b429\b/i.test(message)) return "Arc RPC is temporarily unavailable. Check your wallet activity or Arcscan before retrying because the transaction may already have been submitted.";
  if (/User rejected|User denied|rejected the request/i.test(message)) return "The request was cancelled in your wallet.";
  return message;
}

function rpcErrorText(error: unknown) {
  const parts: string[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const record = current as Record<string, unknown>;
    for (const key of ["shortMessage", "message", "details"] as const) {
      if (typeof record[key] === "string") parts.push(record[key]);
    }
    current = record.cause;
  }
  return parts.join("\n");
}

function isUnauthorizedBlockdaemonRpc(error: unknown) {
  const details = rpcErrorText(error);
  return /(?:\b401\b|Authorization Required)/i.test(details)
    && /(?:blockdaemon|HTTP request failed)/i.test(details);
}

function displayUnits(value: bigint, decimals: number, maximumFractionDigits = decimals === 6 ? 6 : 4) {
  const parsed = Number(formatUnits(value, decimals));
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US", { maximumFractionDigits }) : "—";
}

function inputUnits(value: bigint, decimals: number) {
  const formatted = formatUnits(value, decimals);
  return formatted.includes(".") ? formatted.replace(/\.?0+$/, "") || "0" : formatted;
}

async function readUniswapFallback(clients: PublicClient[], token: Address, pool: Address, side: Side, input: bigint): Promise<QuoteResponse> {
  let lastError: unknown = new Error(`No ${arcChain.name} fallback client is available.`);
  for (const client of clients) {
    try {
      const canonicalPool = await withRpcRetry(() => client.readContract({
        address: ARC_UNISWAP_V3.factory,
        abi: uniswapV3FactoryAbi,
        functionName: "getPool",
        args: [token, ARC_ACTIVE_CONTRACTS.usdc, ARC_UNISWAP_V3.fee],
      }), 2);
      if (canonicalPool === zeroAddress || canonicalPool.toLowerCase() !== pool.toLowerCase()) throw new Error("The launch pool is not canonical.");
      const { result } = await withRpcRetry(() => client.simulateContract({
        address: ARC_UNISWAP_V3.quoter,
        abi: uniswapV3QuoterAbi,
        functionName: "quoteExactInputSingle",
        args: [{
          tokenIn: side === "Buy" ? ARC_ACTIVE_CONTRACTS.usdc : token,
          tokenOut: side === "Buy" ? token : ARC_ACTIVE_CONTRACTS.usdc,
          amountIn: input,
          fee: ARC_UNISWAP_V3.fee,
          sqrtPriceLimitX96: 0n,
        }],
      }), 2);
      return { output: result[0].toString(), fee: (input * BigInt(ARC_UNISWAP_V3.fee) / 1_000_000n).toString(), spender: ARC_UNISWAP_V3.router, pool: canonicalPool };
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

async function estimatePriorityFees(client: PublicClient, priority: Priority): Promise<TransactionFeeOverrides> {
  try {
    const multiplier = priority === "Low" ? 100n : priority === "High" ? 150n : 110n;
    const fees = await client.estimateFeesPerGas();
    return {
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas === undefined ? undefined : fees.maxPriorityFeePerGas * multiplier / 100n,
      maxFeePerGas: fees.maxFeePerGas === undefined ? undefined : fees.maxFeePerGas * multiplier / 100n,
    };
  } catch { return {}; }
}

export function BuySellPanel({ token }: { token: TokenData }) {
  if (!token.poolAddress) return <div id="trade-panel" className="panel scroll-mt-28 p-5"><Badge tone="warn">Onchain data unavailable</Badge><p className="mt-4 text-sm leading-6 text-slate-400">The verified Factory event did not include a usable Uniswap pool. Trading is disabled.</p></div>;
  return <LiveBuySellPanel token={token} poolAddress={token.poolAddress as Address} />;
}

function LiveBuySellPanel({ token, poolAddress }: { token: TokenData; poolAddress: Address }) {
  const [side, setSide] = useState<Side>("Buy");
  const [amount, setAmount] = useState("1");
  const [slippageInput, setSlippageInput] = useState("10");
  const [priority, setPriority] = useState<Priority>("Medium");
  const [status, setStatus] = useState<TransactionStatus>("idle");
  const [notice, setNotice] = useState("");
  const [noticeIsError, setNoticeIsError] = useState(false);
  const [transactionHash, setTransactionHash] = useState<Hash | null>(null);
  const [balances, setBalances] = useState<WalletBalances | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState(false);
  const [liveQuote, setLiveQuote] = useState<LiveQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const submissionLockRef = useRef(false);
  const balanceRefreshInFlightRef = useRef(false);
  const quoteRefreshInFlightRef = useRef(false);
  const quoteRequestRef = useRef(0);
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: arcChain.id });
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const inputDecimals = side === "Buy" ? 6 : 18;
  const inputSymbol = side === "Buy" ? "USDC" : tickerLabel(token.ticker);
  const activeBalance = side === "Buy" ? balances?.usdc : balances?.token;
  const isPending = status !== "idle";
  const slippage = Number(slippageInput);
  const slippageValid = Number.isFinite(slippage) && slippage > 0 && slippage <= MAX_SLIPPAGE_PERCENT;

  const refreshBalances = useCallback(async (background = false) => {
    if (!address || chainId !== arcChain.id || !publicClient) { setBalances(null); return; }
    if (background && balanceRefreshInFlightRef.current) return;
    balanceRefreshInFlightRef.current = true;
    const walletReadClient = walletClient?.chain.id === arcChain.id ? walletClient.extend(publicActions) as unknown as PublicClient : null;
    const clients = [walletReadClient, publicClient].filter((client): client is PublicClient => Boolean(client));
    if (!background) setBalanceLoading(true);
    setBalanceError(false);
    try {
      const readBalance = async (contract: Address) => {
        let lastError: unknown;
        for (const client of clients) {
          try { return await withRpcRetry(() => client.readContract({ address: contract, abi: erc20Abi, functionName: "balanceOf", args: [address] }), 2); } catch (error) { lastError = error; }
        }
        throw lastError;
      };
      setBalances({ usdc: await readBalance(ARC_ACTIVE_CONTRACTS.usdc), token: await readBalance(token.address as Address) });
    } catch { setBalanceError(true); } finally {
      balanceRefreshInFlightRef.current = false;
      if (!background) setBalanceLoading(false);
    }
  }, [address, chainId, publicClient, token.address, walletClient]);

  useLiveRefresh({
    enabled: Boolean(address && chainId === arcChain.id && publicClient),
    intervalMs: BALANCE_POLL_INTERVAL_MS,
    refresh: () => refreshBalances(true),
  });

  useEffect(() => { const timer = window.setTimeout(() => void refreshBalances(), 1_000); return () => window.clearTimeout(timer); }, [refreshBalances]);
  useEffect(() => { setTransactionHash(null); setNotice(""); setNoticeIsError(false); }, [amount, side, slippageInput]);

  async function getClient() {
    if (!isConnected || !address) throw new Error("Connect a wallet before trading.");
    if (chainId !== arcChain.id) { await switchChainAsync({ chainId: arcChain.id }); throw new Error(`${arcChain.name} is now selected. Submit again.`); }
    if (!publicClient) throw new Error(`No ${arcChain.name} public client is available.`);
    return publicClient;
  }

  async function ensureWalletRpc() {
    if (!walletClient || !address || walletClient.chain.id !== arcChain.id) return;
    const walletReadClient = walletClient.extend(publicActions) as unknown as PublicClient;
    try {
      await walletReadClient.getTransactionCount({ address, blockTag: "latest" });
      return;
    } catch (rpcError) {
      if (!isUnauthorizedBlockdaemonRpc(rpcError)) throw rpcError;
    }

    try {
      await walletClient.addChain({ chain: arcChain });
    } catch (repairError) {
      if (/User rejected|User denied|rejected the request/i.test(rpcErrorText(repairError))) throw repairError;
      throw new Error(`Your wallet still uses the retired Blockdaemon Arc RPC. Open wallet settings → Networks → Arc and set the RPC URL to ${ARC_WALLET_RPC_URL}, then retry.`);
    }

    try {
      await walletReadClient.getTransactionCount({ address, blockTag: "latest" });
    } catch {
      throw new Error(`Your wallet did not replace the retired Arc RPC automatically. Open wallet settings → Networks → Arc and set the RPC URL to ${ARC_WALLET_RPC_URL}, then retry.`);
    }
  }

  const readQuote = useCallback(async (): Promise<LiveQuote> => {
    if (!slippageValid) throw new Error(`Slippage must be greater than 0% and no more than ${MAX_SLIPPAGE_PERCENT}%.`);
    const input = parseUnits(amount, inputDecimals);
    if (input <= 0n) throw new Error("Enter an amount greater than zero.");
    let result: QuoteResponse;
    try {
      const response = await fetch(`/api/onchain/quote?token=${encodeURIComponent(token.address)}&pool=${encodeURIComponent(poolAddress)}&side=${side}&amount=${input}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      result = await response.json() as QuoteResponse;
      if (!response.ok) { const error = new Error(result.error || "Unable to read an onchain quote.") as Error & { status?: number }; error.status = response.status; throw error; }
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : null;
      if (status !== null && status < 500) throw error;
      const walletReadClient = walletClient?.chain.id === arcChain.id ? walletClient.extend(publicActions) as unknown as PublicClient : null;
      result = await readUniswapFallback([walletReadClient, publicClient].filter((client): client is PublicClient => Boolean(client)), token.address as Address, poolAddress, side, input);
    }
    if (!result.output || result.fee === undefined || !result.spender || !result.pool) throw new Error(result.error || "Unable to read an onchain quote.");
    const output = BigInt(result.output);
    if (output <= 0n) throw new Error("The pool returned zero output.");
    const slippageBps = BigInt(Math.round(slippage * 100));
    return { input, output, fee: BigInt(result.fee), minimumOutput: output * (10_000n - slippageBps) / 10_000n, spender: result.spender as Address, pool: result.pool as Address };
  }, [amount, inputDecimals, poolAddress, publicClient, side, slippage, slippageValid, token.address, walletClient]);

  const refreshQuote = useCallback(async (background = false) => {
    if (background && quoteRefreshInFlightRef.current) return;
    const requestId = ++quoteRequestRef.current;
    if (!publicClient || !slippageValid || !amount || Number(amount) <= 0) {
      setLiveQuote(null);
      setQuoteLoading(false);
      return;
    }
    quoteRefreshInFlightRef.current = true;
    if (!background) setQuoteLoading(true);
    try {
      const quote = await readQuote();
      if (quoteRequestRef.current !== requestId) return;
      setLiveQuote(quote);
      setQuoteError("");
    } catch {
      if (quoteRequestRef.current !== requestId) return;
      setQuoteError("Quote temporarily unavailable. Retry in a moment.");
    } finally {
      if (quoteRequestRef.current === requestId) {
        quoteRefreshInFlightRef.current = false;
        if (!background) setQuoteLoading(false);
      }
    }
  }, [amount, publicClient, readQuote, slippageValid]);

  useLiveRefresh({
    enabled: Boolean(publicClient && slippageValid && amount && Number(amount) > 0),
    intervalMs: QUOTE_POLL_INTERVAL_MS,
    refresh: () => refreshQuote(true),
  });

  useEffect(() => {
    setLiveQuote(null); setQuoteError("");
    if (!publicClient || !slippageValid || !amount || Number(amount) <= 0) { setQuoteLoading(false); return; }
    const timer = window.setTimeout(() => void refreshQuote(false), 300);
    return () => window.clearTimeout(timer);
  }, [amount, publicClient, refreshQuote, side, slippageInput, slippageValid]);

  async function submitTrade() {
    if (!address) { setNotice("Connect a wallet to trade."); setNoticeIsError(true); return; }
    if (submissionLockRef.current) return;
    submissionLockRef.current = true; setStatus("quoting"); setNotice(""); setTransactionHash(null);
    try {
      const client = await getClient();
      await ensureWalletRpc();
      const quote = await readQuote();
      setStatus("preparing");
      const approvalToken = (side === "Buy" ? ARC_ACTIVE_CONTRACTS.usdc : token.address) as Address;
      const allowance = await withRpcRetry(() => client.readContract({ address: approvalToken, abi: erc20Abi, functionName: "allowance", args: [address, quote.spender] }));
      if (allowance < quote.input) {
        setStatus("approving");
        const approvalHash = await writeContractAsync({ address: approvalToken, abi: erc20Abi, functionName: "approve", args: [quote.spender, quote.input], ...await estimatePriorityFees(client as PublicClient, priority) });
        setTransactionHash(approvalHash);
        if ((await withRpcRetry(() => client.waitForTransactionReceipt({ hash: approvalHash }))).status !== "success") throw new Error(`${inputSymbol} approval reverted onchain.`);
      }
      setStatus("trading");
      const tradeHash = await writeContractAsync({
        address: ARC_UNISWAP_V3.router,
        abi: uniswapV3RouterAbi,
        functionName: "exactInputSingle",
        args: [{ tokenIn: approvalToken, tokenOut: (side === "Buy" ? token.address : ARC_ACTIVE_CONTRACTS.usdc) as Address, fee: ARC_UNISWAP_V3.fee, recipient: address, amountIn: quote.input, amountOutMinimum: quote.minimumOutput, sqrtPriceLimitX96: 0n }],
        ...await estimatePriorityFees(client as PublicClient, priority),
      });
      setTransactionHash(tradeHash);
      const receipt = await withRpcRetry(() => client.waitForTransactionReceipt({ hash: tradeHash }));
      if (receipt.status !== "success") throw new Error(`${side} transaction reverted onchain.`);
      let confirmed: { usdc: bigint; tokens: bigint } | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== poolAddress.toLowerCase()) continue;
        try {
          const event = decodeEventLog({ abi: uniswapV3PoolAbi, eventName: "Swap", data: log.data, topics: log.topics });
          const tokenIs0 = token.address.toLowerCase() < ARC_ACTIVE_CONTRACTS.usdc.toLowerCase();
          const tokenDelta = tokenIs0 ? event.args.amount0 : event.args.amount1;
          const usdcDelta = tokenIs0 ? event.args.amount1 : event.args.amount0;
          confirmed = { usdc: usdcDelta < 0n ? -usdcDelta : usdcDelta, tokens: tokenDelta < 0n ? -tokenDelta : tokenDelta };
          break;
        } catch { /* Ignore non-Swap receipt logs. */ }
      }
      setNotice(`${side} confirmed on ${arcChain.name}.`); setNoticeIsError(false);
      if (confirmed) window.dispatchEvent(new CustomEvent("arcforge:trade-confirmed", { detail: { tokenAddress: token.address, transactionHash: tradeHash, side, wallet: address, blockNumber: receipt.blockNumber.toString(), timestamp: Math.floor(Date.now() / 1_000), usdc: Number(formatUnits(confirmed.usdc, 6)), fee: Number(formatUnits(quote.fee, 6)), tokens: Number(formatUnits(confirmed.tokens, 18)) } }));
      void refreshBalances();
    } catch (error) { setNotice(transactionError(error)); setNoticeIsError(true); } finally { submissionLockRef.current = false; setStatus("idle"); }
  }

  const actionLabel = status === "quoting" ? "Reading quote…" : status === "preparing" ? "Preparing transaction…" : status === "approving" ? `Approving ${inputSymbol}…` : status === "trading" ? `${side} pending…` : `${side} ${tickerLabel(token.ticker)}`;
  const balanceLabel = !address ? "Connect wallet" : chainId !== arcChain.id ? `Switch to ${arcChain.name}` : balanceLoading ? "Reading balance…" : activeBalance === undefined ? balanceError ? "Balance unavailable · Retry" : "Balance unavailable" : `Balance ${displayUnits(activeBalance, inputDecimals)} ${inputSymbol}`;
  const outputDecimals = side === "Buy" ? 18 : 6;
  const outputSymbol = side === "Buy" ? tickerLabel(token.ticker) : "USDC";

  return <div id="trade-panel" className="panel scroll-mt-28 rounded-[28px] p-5 shadow-none">
    <p className="mb-4 text-lg font-semibold tracking-[-.03em] text-white">Trade {tickerLabel(token.ticker)}</p>
    <div className="grid grid-cols-2 gap-1 rounded-full bg-black/20 p-1">{(["Buy", "Sell"] as const).map((item) => <button key={item} disabled={isPending} onClick={() => setSide(item)} className={`h-10 rounded-full text-sm font-semibold transition disabled:opacity-50 ${side === item ? item === "Buy" ? "bg-emerald-400/15 text-emerald-300" : "bg-rose-400/15 text-rose-300" : "text-slate-500"}`}>{item}</button>)}</div>
    <div className="mt-5 flex items-center justify-between gap-3"><label className="label mb-0 text-[15px]">You pay</label><div className="flex items-center gap-3"><button type="button" disabled={!balanceError || balanceLoading} onClick={() => void refreshBalances()} className={balanceError ? "text-sm text-cyan" : "text-sm text-slate-400"}>{balanceLabel}</button><span className="flex items-center gap-1 text-sm text-slate-400"><Settings2 className="size-4" />{slippageValid ? `${slippage}%` : "Invalid"} · {priority}</span></div></div>
    <div className="mt-2 flex items-center rounded-2xl bg-black/20 px-4 ring-1 ring-inset ring-line/70"><input inputMode="decimal" value={amount} disabled={isPending} onChange={(event) => setAmount(event.target.value)} className="h-14 min-w-0 flex-1 bg-transparent text-xl font-semibold outline-none" /><Badge tone="neutral">{inputSymbol}</Badge></div>
    <div className="mt-2 grid grid-cols-5 gap-1">{percentageOptions.map((percent) => <button key={percent} type="button" disabled={isPending || !activeBalance} onClick={() => activeBalance !== undefined && setAmount(inputUnits(activeBalance * BigInt(percent) / 100n, inputDecimals))} className="h-9 rounded-full font-mono text-sm text-slate-400 disabled:opacity-60">{percent}%</button>)}</div>
    <div className="mt-4 border-y border-line/70 py-3"><div className="flex justify-between"><span className="text-slate-300">You receive</span><span className="font-mono font-semibold">{quoteLoading ? "Reading…" : liveQuote ? `${displayUnits(liveQuote.output, outputDecimals, side === "Buy" ? 0 : 6)} ${outputSymbol}` : `— ${outputSymbol}`}</span></div><div className="mt-2 flex justify-between text-sm text-slate-400"><span>Minimum received</span><span className="font-mono">{liveQuote ? `${displayUnits(liveQuote.minimumOutput, outputDecimals)} ${outputSymbol}` : "—"}</span></div>{quoteError && <p className="mt-2 text-sm text-amber-300">{quoteError}</p>}</div>
    <div className="mt-3 grid gap-3 py-2"><div className="flex items-start justify-between gap-3"><span className="pt-2 text-slate-300">Slippage</span><div className="flex flex-wrap justify-end gap-1">{slippageOptions.map((value) => <button key={value} type="button" disabled={isPending} onClick={() => setSlippageInput(String(value))} className={`h-9 rounded-full px-3 font-mono text-sm disabled:opacity-50 ${slippage === value ? "bg-cyan/12 text-cyan" : "text-slate-400"}`}>{value}%</button>)}<label className="flex h-9 w-[86px] items-center rounded-full border border-line px-2"><input aria-label="Custom slippage percentage" inputMode="decimal" value={slippageInput} disabled={isPending} onChange={(event) => /^\d{0,2}(?:\.\d{0,2})?$/.test(event.target.value) && setSlippageInput(event.target.value)} className="min-w-0 flex-1 bg-transparent text-right outline-none disabled:opacity-50" /><span>%</span></label></div></div><div className="flex items-center justify-between"><span className="text-slate-300">Priority</span><div className="flex gap-1">{priorityOptions.map((value) => <button key={value} type="button" onClick={() => setPriority(value)} className={`h-9 rounded-full px-3 text-sm ${priority === value ? "bg-cyan/12 text-cyan" : "text-slate-400"}`}>{value}</button>)}</div></div></div>
    <Button className="mt-4 w-full" disabled={isPending || !slippageValid} onClick={() => void submitTrade()}>{actionLabel}</Button>
    {notice && <p role={noticeIsError ? "alert" : "status"} className={`mt-3 rounded-lg border p-3 text-sm ${noticeIsError ? "border-rose-400/20 text-rose-200" : "border-emerald-400/15 text-emerald-300"}`}>{notice}{transactionHash && <span className="ml-2"><ArcscanLink hash={transactionHash} label="View transaction" /></span>}</p>}
    <p className="mt-4 text-sm leading-6 text-slate-400">Trades execute through the canonical Uniswap V3 pool. The LP position cannot be withdrawn.</p>
  </div>;
}
