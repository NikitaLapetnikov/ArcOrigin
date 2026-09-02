"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { createPublicClient, custom, decodeEventLog, formatUnits, http, isAddress, maxUint256, parseUnits, type Address, type Hash, type PublicClient, type WalletClient } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient, useWriteContract } from "wagmi";
import { nativeUsdcToPrecompileBalance } from "@/lib/arc-usdc";
import { ARC_ACTIVE_CONTRACTS, ARC_UNISWAP_V3, arcChain } from "@/lib/chains";
import { erc20Abi, uniswapV3PoolAbi, uniswapV3QuoterAbi, uniswapV3RouterAbi } from "@/lib/contracts";
import { isRetryableRpcError, isRpcCapacityError, isUnauthorizedBlockdaemonRpc, rpcErrorText } from "@/lib/rpc-errors";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { ARC_RPC_RELAY_URL, createBrowserArcReadClient } from "@/lib/onchain/browser-arc-rpc";
import type { TokenData } from "@/lib/types";
import { tickerLabel } from "@/lib/utils";
import { ArcscanLink, Badge, Button } from "./ui";

type Side = "Buy" | "Sell";
type LiveQuote = {
  input: bigint;
  output: bigint;
  fee: bigint;
  minimumOutput: bigint;
  spender: Address;
  pool: Address;
  side: Side;
  slippageBps: bigint;
  quotedAt: number;
};
type QuoteResponse = { output?: string; fee?: string; spender?: string; pool?: string; quotedAt?: number; error?: string };
type WalletBalanceResponse = {
  nativeBalance?: string | null;
  usdcBalance?: string | null;
  balances?: Array<{ tokenAddress?: string; balance?: string }>;
  error?: string;
};
type TransactionStatus = "idle" | "checking-rpc" | "quoting" | "preparing" | "approving" | "trading";
type WalletBalances = { usdc: bigint; token: bigint; native: bigint };
const percentageOptions = [10, 25, 50, 75, 100] as const;
const slippageOptions = [10, 20, 40] as const;
const MAX_SLIPPAGE_PERCENT = 50;
const BALANCE_POLL_INTERVAL_MS = 10_000;
const QUOTE_POLL_INTERVAL_MS = 4_000;
const MAX_EXECUTION_QUOTE_AGE_MS = 8_000;
const DIRECT_QUOTE_TIMEOUT_MS = 6_000;
const DIRECT_QUOTE_HEDGE_DELAY_MS = 125;
const DIRECT_QUOTE_START_DELAY_MS = 350;
const FAST_RPC_READ_TIMEOUT_MS = 10_000;
const ARC_WALLET_RPC_URL = ARC_RPC_RELAY_URL;
const MAX_INPUT_CHARACTERS = 80;
const directQuoteClients = arcChain.rpcUrls.default.http.map((url) => createPublicClient({
  chain: arcChain,
  transport: http(url, { retryCount: 0, timeout: DIRECT_QUOTE_TIMEOUT_MS }),
}));
const resilientReadClient = createBrowserArcReadClient();

class RpcReadTimeoutError extends Error {
  constructor() {
    super("Arc RPC read timed out.");
    this.name = "RpcReadTimeoutError";
  }
}

function wait(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function withReadTimeout<T>(operation: Promise<T>, timeoutMs = FAST_RPC_READ_TIMEOUT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RpcReadTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withRpcRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(); } catch (error) {
      if (!isRetryableRpcError(error) || attempt === attempts) throw error;
      await wait(attempt * 900);
    }
  }
  throw new Error("Arc RPC request failed after retries.");
}

function transactionError(error: unknown) {
  const details = rpcErrorText(error);
  const message = typeof error === "object" && error && "shortMessage" in error ? String(error.shortMessage) : error instanceof Error ? error.message : "The wallet transaction failed.";
  if (isUnauthorizedBlockdaemonRpc(error)) return `Your wallet still uses the retired Blockdaemon Arc RPC. Open wallet settings → Networks → Arc and set the RPC URL to ${ARC_WALLET_RPC_URL}, then retry.`;
  if (/User rejected|User denied|rejected the request/i.test(details || message)) return "The request was cancelled in your wallet.";
  if (/insufficient funds|insufficient balance/i.test(details)) return "Insufficient balance. Keep enough USDC for the trade and a small native USDC balance for gas.";
  if (/Too little received|amountOutMinimum|price impact|slippage|SPL/i.test(details)) return "The price moved beyond your slippage limit. The trade was not executed; refresh the quote and retry.";
  if (/nonce too low|replacement transaction underpriced|already known/i.test(details)) return "Your wallet has a pending or recently submitted transaction. Check wallet activity before retrying.";
  if (isRpcCapacityError(error)) return "Arc RPC is busy. Check your wallet for a pending transaction; if none appears, wait a few seconds and retry.";
  if (isRetryableRpcError(error)) return "Arc RPC is temporarily unavailable. Check wallet activity before retrying because a signed transaction may already have been submitted.";
  if (/execution reverted|ContractFunctionExecutionError/i.test(details)) return "The trade no longer passes onchain checks. Refresh the quote and retry; no failed trade was submitted.";
  return message;
}

function parseTradeAmount(value: string, decimals: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_INPUT_CHARACTERS || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null;
  const fraction = normalized.split(".")[1] ?? "";
  if (fraction.length > decimals) return null;
  try {
    const parsed = parseUnits(normalized, decimals);
    return parsed > 0n && parsed <= maxUint256 ? parsed : null;
  } catch {
    return null;
  }
}

function acceptsTradeInput(value: string, decimals: number) {
  if (value.length > MAX_INPUT_CHARACTERS) return false;
  return new RegExp(`^\\d*(?:\\.\\d{0,${decimals}})?$`).test(value);
}

function displayUnits(value: bigint, decimals: number, maximumFractionDigits = decimals === 6 ? 6 : 4) {
  const parsed = Number(formatUnits(value, decimals));
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US", { maximumFractionDigits }) : "—";
}

function inputUnits(value: bigint, decimals: number) {
  const formatted = formatUnits(value, decimals);
  return formatted.includes(".") ? formatted.replace(/\.?0+$/, "") || "0" : formatted;
}

async function readWalletBalances(wallet: Address, token: Address): Promise<WalletBalances> {
  const response = await fetch(`/api/onchain/wallets/${encodeURIComponent(wallet)}/balances`, { cache: "no-store" });
  const payload = await response.json() as WalletBalanceResponse;
  if (!response.ok || !Array.isArray(payload.balances)) {
    throw new Error(payload.error || "Indexed wallet balances are unavailable.");
  }
  const indexedToken = payload.balances.find((balance) => (
    typeof balance.tokenAddress === "string"
    && isAddress(balance.tokenAddress)
    && balance.tokenAddress.toLowerCase() === token.toLowerCase()
  ));
  const rawTokenBalance = indexedToken?.balance ?? "0";
  if (!/^\d+$/.test(rawTokenBalance)) throw new Error("Indexed token balance is invalid.");

  let nativeBalance: bigint;
  if (typeof payload.nativeBalance === "string" && /^\d+$/.test(payload.nativeBalance)) {
    nativeBalance = BigInt(payload.nativeBalance);
  } else {
    nativeBalance = await withReadTimeout(resilientReadClient.getBalance({ address: wallet }), 4_000);
  }
  const usdcBalance = typeof payload.usdcBalance === "string" && /^\d+$/.test(payload.usdcBalance)
    ? BigInt(payload.usdcBalance)
    : nativeUsdcToPrecompileBalance(nativeBalance);
  return { usdc: usdcBalance, token: BigInt(rawTokenBalance), native: nativeBalance };
}

async function readAllowance(client: PublicClient, token: Address, owner: Address, spender: Address) {
  try {
    return await withReadTimeout(client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    }));
  } catch (error) {
    if (error instanceof RpcReadTimeoutError || isRetryableRpcError(error)) return null;
    throw error;
  }
}

function createWalletReadClient(walletClient: WalletClient) {
  return createPublicClient({
    chain: arcChain,
    transport: custom(walletClient.transport),
  });
}

async function readWalletBalancesDirect(client: PublicClient, wallet: Address, token: Address): Promise<WalletBalances> {
  const [nativeBalance, usdcBalance, tokenBalance] = await Promise.all([
    client.getBalance({ address: wallet }),
    client.readContract({ address: ARC_ACTIVE_CONTRACTS.usdc, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }),
  ]);
  return { native: nativeBalance, usdc: usdcBalance, token: tokenBalance };
}

async function readDirectQuote(token: Address, pool: Address, side: Side, input: bigint): Promise<QuoteResponse> {
  if (directQuoteClients.length === 0) throw new Error(`No ${arcChain.name} quote RPC is configured.`);
  const hedgeController = new AbortController();
  try {
    return await Promise.any(directQuoteClients.map(async (client, index) => {
      if (index > 0) await wait(index * DIRECT_QUOTE_HEDGE_DELAY_MS);
      if (hedgeController.signal.aborted) throw new Error("Direct quote hedge cancelled.");
      const { result } = await client.simulateContract({
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
      });
      return { output: result[0].toString(), fee: (input * BigInt(ARC_UNISWAP_V3.fee) / 1_000_000n).toString(), spender: ARC_UNISWAP_V3.router, pool, quotedAt: Date.now() };
    }));
  } finally {
    hedgeController.abort();
  }
}

export function BuySellPanel({ token }: { token: TokenData }) {
  if (!token.poolAddress) return <div id="trade-panel" className="panel scroll-mt-28 p-5"><Badge tone="warn">Onchain data unavailable</Badge><p className="mt-4 text-sm leading-6 text-slate-400">The verified Factory event did not include a usable Uniswap pool. Trading is disabled.</p></div>;
  return <LiveBuySellPanel token={token} poolAddress={token.poolAddress as Address} />;
}

function LiveBuySellPanel({ token, poolAddress }: { token: TokenData; poolAddress: Address }) {
  const [side, setSide] = useState<Side>("Buy");
  const [amount, setAmount] = useState("1");
  const [slippageInput, setSlippageInput] = useState("10");
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
  const parsedAmount = parseTradeAmount(amount, inputDecimals);
  const amountExceedsBalance = parsedAmount !== null && activeBalance !== undefined && parsedAmount > activeBalance;

  const refreshBalances = useCallback(async (background = false) => {
    if (!address || chainId !== arcChain.id) { setBalances(null); return; }
    if (background && balanceRefreshInFlightRef.current) return;
    balanceRefreshInFlightRef.current = true;
    if (!background) setBalanceLoading(true);
    setBalanceError(false);
    try {
      setBalances(await readWalletBalances(address, token.address as Address));
    } catch { setBalanceError(true); } finally {
      balanceRefreshInFlightRef.current = false;
      if (!background) setBalanceLoading(false);
    }
  }, [address, chainId, token.address]);

  useLiveRefresh({
    enabled: Boolean(address && chainId === arcChain.id),
    intervalMs: BALANCE_POLL_INTERVAL_MS,
    refresh: () => refreshBalances(true),
  });

  useEffect(() => { const timer = window.setTimeout(() => void refreshBalances(), 0); return () => window.clearTimeout(timer); }, [refreshBalances]);
  useEffect(() => { setTransactionHash(null); setNotice(""); setNoticeIsError(false); }, [amount, side, slippageInput]);

  async function getClient() {
    if (!isConnected || !address) throw new Error("Connect a wallet before trading.");
    if (chainId !== arcChain.id) { await switchChainAsync({ chainId: arcChain.id }); throw new Error(`${arcChain.name} is now selected. Submit again.`); }
    if (!publicClient) throw new Error(`No ${arcChain.name} public client is available.`);
    return resilientReadClient;
  }

  const readQuote = useCallback(async (): Promise<LiveQuote> => {
    if (!publicClient) throw new Error(`No ${arcChain.name} public client is available.`);
    if (!slippageValid) throw new Error(`Slippage must be greater than 0% and no more than ${MAX_SLIPPAGE_PERCENT}%.`);
    const input = parseTradeAmount(amount, inputDecimals);
    if (input === null) throw new Error(`Enter a valid amount with no more than ${inputDecimals} decimal places.`);
    const quoteController = new AbortController();
    const serverQuote = (async () => {
      const response = await fetch(`/api/onchain/quote?token=${encodeURIComponent(token.address)}&pool=${encodeURIComponent(poolAddress)}&side=${side}&amount=${input}`, { cache: "no-store", signal: quoteController.signal });
      const result = await response.json() as QuoteResponse;
      if (!response.ok) { const error = new Error(result.error || "Unable to read an onchain quote.") as Error & { status?: number }; error.status = response.status; throw error; }
      return result;
    })();
    const directQuote = (async () => {
      await wait(DIRECT_QUOTE_START_DELAY_MS);
      if (quoteController.signal.aborted) throw new Error("Direct quote fallback cancelled.");
      return readDirectQuote(token.address as Address, poolAddress, side, input);
    })();
    let result: QuoteResponse;
    try {
      result = await Promise.any([
        serverQuote,
        directQuote,
      ]);
    } finally {
      quoteController.abort();
    }
    if (!result.output || result.fee === undefined || !result.spender || !result.pool) throw new Error(result.error || "Unable to read an onchain quote.");
    if (!isAddress(result.spender)
      || result.spender.toLowerCase() !== ARC_UNISWAP_V3.router.toLowerCase()
      || !isAddress(result.pool)
      || result.pool.toLowerCase() !== poolAddress.toLowerCase()) {
      throw new Error("The quote did not return the verified ArcOrigin router and pool.");
    }
    const output = BigInt(result.output);
    if (output <= 0n) throw new Error("The pool returned zero output.");
    const slippageBps = BigInt(Math.round(slippage * 100));
    return {
      input,
      output,
      fee: BigInt(result.fee),
      minimumOutput: output * (10_000n - slippageBps) / 10_000n,
      spender: result.spender as Address,
      pool: result.pool as Address,
      side,
      slippageBps,
      quotedAt: typeof result.quotedAt === "number" && Number.isFinite(result.quotedAt)
        ? result.quotedAt
        : Date.now(),
    };
  }, [amount, inputDecimals, poolAddress, publicClient, side, slippage, slippageValid, token.address]);

  const refreshQuote = useCallback(async (background = false) => {
    if (background && quoteRefreshInFlightRef.current) return;
    const requestId = ++quoteRequestRef.current;
    if (!publicClient || !slippageValid || parsedAmount === null) {
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
    } catch (error) {
      if (quoteRequestRef.current !== requestId) return;
      setQuoteError(isRpcCapacityError(error) ? "Arc RPC is busy. Retrying automatically…" : "Quote temporarily unavailable. Retrying automatically…");
    } finally {
      if (quoteRequestRef.current === requestId) {
        quoteRefreshInFlightRef.current = false;
        if (!background) setQuoteLoading(false);
      }
    }
  }, [parsedAmount, publicClient, readQuote, slippageValid]);

  useLiveRefresh({
    enabled: Boolean(publicClient && slippageValid && parsedAmount !== null),
    intervalMs: QUOTE_POLL_INTERVAL_MS,
    refresh: () => refreshQuote(true),
  });

  useEffect(() => {
    setLiveQuote(null); setQuoteError("");
    if (!publicClient || !slippageValid || parsedAmount === null) { setQuoteLoading(false); return; }
    const timer = window.setTimeout(() => void refreshQuote(false), 300);
    return () => window.clearTimeout(timer);
  }, [amount, parsedAmount, publicClient, refreshQuote, side, slippageInput, slippageValid]);

  async function submitTrade() {
    if (!address) { setNotice("Connect a wallet to trade."); setNoticeIsError(true); return; }
    if (submissionLockRef.current) return;
    submissionLockRef.current = true; setStatus("checking-rpc"); setNotice(""); setTransactionHash(null);
    try {
      await getClient();
      if (!walletClient) throw new Error("The connected wallet is not ready. Reconnect it and retry.");
      const walletReadClient = createWalletReadClient(walletClient);
      const currentSlippageBps = BigInt(Math.round(slippage * 100));
      let executionQuote = liveQuote
        && liveQuote.input === parsedAmount
        && liveQuote.side === side
        && liveQuote.slippageBps === currentSlippageBps
        && Date.now() - liveQuote.quotedAt <= MAX_EXECUTION_QUOTE_AGE_MS
        ? liveQuote
        : await (async () => { setStatus("quoting"); return readQuote(); })();
      setStatus("preparing");
      const approvalToken = (side === "Buy" ? ARC_ACTIVE_CONTRACTS.usdc : token.address) as Address;
      let freshBalances = await readWalletBalancesDirect(walletReadClient, address, token.address as Address);
      setBalances(freshBalances);
      const currentBalance = side === "Buy" ? freshBalances.usdc : freshBalances.token;
      const allowance = await readAllowance(walletReadClient, approvalToken, address, executionQuote.spender);
      if (currentBalance < executionQuote.input) throw new Error(`Insufficient ${inputSymbol} balance.`);
      if (allowance === null || allowance < executionQuote.input) {
        setStatus("approving");
        const approvalArgs = [executionQuote.spender, executionQuote.input] as const;
        const approvalHash = await writeContractAsync({ address: approvalToken, abi: erc20Abi, functionName: "approve", args: approvalArgs });
        setTransactionHash(approvalHash);
        if ((await withRpcRetry(() => walletReadClient.waitForTransactionReceipt({ hash: approvalHash }))).status !== "success") throw new Error(`${inputSymbol} approval reverted onchain.`);
        setStatus("quoting");
        executionQuote = await readQuote();
        freshBalances = await readWalletBalancesDirect(walletReadClient, address, token.address as Address);
        setBalances(freshBalances);
      }
      setStatus("preparing");
      const tradeArgs = [{
        tokenIn: approvalToken,
        tokenOut: (side === "Buy" ? token.address : ARC_ACTIVE_CONTRACTS.usdc) as Address,
        fee: ARC_UNISWAP_V3.fee,
        recipient: address,
        amountIn: executionQuote.input,
        amountOutMinimum: executionQuote.minimumOutput,
        sqrtPriceLimitX96: 0n,
      }] as const;
      setStatus("trading");
      const tradeHash = await writeContractAsync({
        address: ARC_UNISWAP_V3.router,
        abi: uniswapV3RouterAbi,
        functionName: "exactInputSingle",
        args: tradeArgs,
      });
      setTransactionHash(tradeHash);
      const receipt = await withRpcRetry(() => walletReadClient.waitForTransactionReceipt({ hash: tradeHash }));
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
      if (confirmed) window.dispatchEvent(new CustomEvent("arcforge:trade-confirmed", { detail: { tokenAddress: token.address, transactionHash: tradeHash, side, wallet: address, blockNumber: receipt.blockNumber.toString(), timestamp: Math.floor(Date.now() / 1_000), usdc: Number(formatUnits(confirmed.usdc, 6)), fee: Number(formatUnits(executionQuote.fee, 6)), tokens: Number(formatUnits(confirmed.tokens, 18)) } }));
      void refreshBalances();
    } catch (error) { setNotice(transactionError(error)); setNoticeIsError(true); } finally { submissionLockRef.current = false; setStatus("idle"); }
  }

  const idleActionLabel = parsedAmount === null ? "Enter a valid amount" : amountExceedsBalance ? `Insufficient ${inputSymbol}` : quoteLoading || !liveQuote ? "Waiting for live quote…" : `${side} ${tickerLabel(token.ticker)}`;
  const actionLabel = status === "checking-rpc" ? "Checking Arc network…" : status === "quoting" ? "Refreshing quote…" : status === "preparing" ? "Preparing transaction…" : status === "approving" ? `Approving ${inputSymbol}…` : status === "trading" ? `${side} pending…` : idleActionLabel;
  const tradeDisabled = isPending || !slippageValid || parsedAmount === null || amountExceedsBalance || quoteLoading || !liveQuote;
  const balanceLabel = !address ? "Connect wallet" : chainId !== arcChain.id ? `Switch to ${arcChain.name}` : balanceLoading ? "Reading balance…" : activeBalance === undefined ? balanceError ? "Balance unavailable · Retry" : "Balance unavailable" : `Balance ${displayUnits(activeBalance, inputDecimals)} ${inputSymbol}`;
  const outputDecimals = side === "Buy" ? 18 : 6;
  const outputSymbol = side === "Buy" ? tickerLabel(token.ticker) : "USDC";

  return <div id="trade-panel" className="panel scroll-mt-28 rounded-[28px] p-5 shadow-none">
    <p className="mb-4 text-lg font-semibold tracking-[-.03em] text-white">Trade {tickerLabel(token.ticker)}</p>
    <div className="grid grid-cols-2 gap-1 rounded-full bg-black/20 p-1">{(["Buy", "Sell"] as const).map((item) => <button key={item} disabled={isPending} onClick={() => setSide(item)} className={`h-10 rounded-full text-sm font-semibold transition disabled:opacity-50 ${side === item ? item === "Buy" ? "bg-emerald-400/15 text-emerald-300" : "bg-rose-400/15 text-rose-300" : "text-slate-500"}`}>{item}</button>)}</div>
    <div className="mt-5 flex items-center justify-between gap-3"><label className="label mb-0 text-[15px]">You pay</label><div className="flex items-center gap-3"><button type="button" disabled={!balanceError || balanceLoading} onClick={() => void refreshBalances()} className={balanceError ? "text-sm text-cyan" : "text-sm text-slate-400"}>{balanceLabel}</button><span className="flex items-center gap-1 text-sm text-slate-400"><Settings2 className="size-4" />{slippageValid ? `${slippage}%` : "Invalid"} · Wallet gas</span></div></div>
    <div className="mt-2 flex items-center rounded-2xl bg-black/20 px-4 ring-1 ring-inset ring-line/70"><input inputMode="decimal" value={amount} disabled={isPending} onChange={(event) => acceptsTradeInput(event.target.value, inputDecimals) && setAmount(event.target.value)} className="h-14 min-w-0 flex-1 bg-transparent text-xl font-semibold outline-none" /><Badge tone="neutral">{inputSymbol}</Badge></div>
    {amountExceedsBalance && <p className="mt-2 text-sm text-rose-300">Amount exceeds your available {inputSymbol} balance.</p>}
    <div className="mt-2 grid grid-cols-5 gap-1">{percentageOptions.map((percent) => <button key={percent} type="button" disabled={isPending || !activeBalance} onClick={() => activeBalance !== undefined && setAmount(inputUnits(activeBalance * BigInt(percent) / 100n, inputDecimals))} className="h-9 rounded-full font-mono text-sm text-slate-400 disabled:opacity-60">{percent}%</button>)}</div>
    <div className="mt-4 border-y border-line/70 py-3"><div className="flex justify-between"><span className="text-slate-300">You receive</span><span className="font-mono font-semibold">{quoteLoading ? "Reading…" : liveQuote ? `${displayUnits(liveQuote.output, outputDecimals, side === "Buy" ? 0 : 6)} ${outputSymbol}` : `— ${outputSymbol}`}</span></div><div className="mt-2 flex justify-between text-sm text-slate-400"><span>Minimum received</span><span className="font-mono">{liveQuote ? `${displayUnits(liveQuote.minimumOutput, outputDecimals)} ${outputSymbol}` : "—"}</span></div>{quoteError && <p className="mt-2 text-sm text-amber-300">{quoteError}</p>}</div>
    <div className="mt-3 py-2"><div className="flex items-start justify-between gap-3"><span className="pt-2 text-slate-300">Slippage</span><div className="flex flex-wrap justify-end gap-1">{slippageOptions.map((value) => <button key={value} type="button" disabled={isPending} onClick={() => setSlippageInput(String(value))} className={`h-9 rounded-full px-3 font-mono text-sm disabled:opacity-50 ${slippage === value ? "bg-cyan/12 text-cyan" : "text-slate-400"}`}>{value}%</button>)}<label className="flex h-9 w-[86px] items-center rounded-full border border-line px-2"><input aria-label="Custom slippage percentage" inputMode="decimal" value={slippageInput} disabled={isPending} onChange={(event) => /^\d{0,2}(?:\.\d{0,2})?$/.test(event.target.value) && setSlippageInput(event.target.value)} className="min-w-0 flex-1 bg-transparent text-right outline-none disabled:opacity-50" /><span>%</span></label></div></div></div>
    <Button className="mt-4 w-full" disabled={tradeDisabled} onClick={() => void submitTrade()}>{actionLabel}</Button>
    {notice && <p role={noticeIsError ? "alert" : "status"} className={`mt-3 rounded-lg border p-3 text-sm ${noticeIsError ? "border-rose-400/20 text-rose-200" : "border-emerald-400/15 text-emerald-300"}`}>{notice}{transactionHash && <span className="ml-2"><ArcscanLink hash={transactionHash} label="View transaction" /></span>}</p>}
    <p className="mt-4 text-sm leading-6 text-slate-400">Trades execute through the canonical Uniswap V3 pool. The LP position cannot be withdrawn.</p>
  </div>;
}
