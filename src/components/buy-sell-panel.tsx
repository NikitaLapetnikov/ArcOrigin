"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { createPublicClient, decodeEventLog, formatUnits, http, isAddress, maxUint256, parseUnits, publicActions, type Address, type Hash, type PublicClient } from "viem";
import { useAccount, usePublicClient, useSwitchChain, useWalletClient, useWriteContract } from "wagmi";
import { requiredNativeUsdcBalance } from "@/lib/arc-usdc";
import { ARC_ACTIVE_CONTRACTS, ARC_UNISWAP_V3, arcChain } from "@/lib/chains";
import { erc20Abi, uniswapV3PoolAbi, uniswapV3QuoterAbi, uniswapV3RouterAbi } from "@/lib/contracts";
import { isRetryableRpcError, isRpcCapacityError, isUnauthorizedBlockdaemonRpc, rpcErrorText, walletRpcPreflightDecision } from "@/lib/rpc-errors";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import type { TokenData } from "@/lib/types";
import { tickerLabel } from "@/lib/utils";
import { ArcscanLink, Badge, Button } from "./ui";

type Side = "Buy" | "Sell";
type Priority = "Low" | "Medium" | "High";
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
type QuoteResponse = { output?: string; fee?: string; spender?: string; pool?: string; error?: string };
type TransactionStatus = "idle" | "checking-rpc" | "quoting" | "preparing" | "approving" | "trading";
type WalletBalances = { usdc: bigint; token: bigint };
type TransactionFeeOverrides =
  | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { gasPrice: bigint };
const percentageOptions = [10, 25, 50, 75, 100] as const;
const slippageOptions = [10, 20, 40] as const;
const priorityOptions: Priority[] = ["Low", "Medium", "High"];
const MAX_SLIPPAGE_PERCENT = 50;
const BALANCE_POLL_INTERVAL_MS = 10_000;
const QUOTE_POLL_INTERVAL_MS = 5_000;
const MAX_EXECUTION_QUOTE_AGE_MS = 8_000;
const DIRECT_QUOTE_TIMEOUT_MS = 6_000;
const DIRECT_QUOTE_HEDGE_DELAY_MS = 250;
const DIRECT_QUOTE_START_DELAY_MS = 1_200;
const ARC_WALLET_RPC_URL = arcChain.rpcUrls.default.http[0];
const MAX_INPUT_CHARACTERS = 80;
const directQuoteClients = arcChain.rpcUrls.default.http.map((url) => createPublicClient({
  chain: arcChain,
  transport: http(url, { retryCount: 0, timeout: DIRECT_QUOTE_TIMEOUT_MS }),
}));

function wait(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

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

function gasWithSafetyMargin(estimate: bigint) {
  return estimate * 120n / 100n + 5_000n;
}

function displayUnits(value: bigint, decimals: number, maximumFractionDigits = decimals === 6 ? 6 : 4) {
  const parsed = Number(formatUnits(value, decimals));
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US", { maximumFractionDigits }) : "—";
}

function inputUnits(value: bigint, decimals: number) {
  const formatted = formatUnits(value, decimals);
  return formatted.includes(".") ? formatted.replace(/\.?0+$/, "") || "0" : formatted;
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
      return { output: result[0].toString(), fee: (input * BigInt(ARC_UNISWAP_V3.fee) / 1_000_000n).toString(), spender: ARC_UNISWAP_V3.router, pool };
    }));
  } finally {
    hedgeController.abort();
  }
}

async function estimatePriorityFees(client: PublicClient, priority: Priority): Promise<TransactionFeeOverrides> {
  const multiplier = priority === "Low" ? 100n : priority === "High" ? 150n : 110n;
  const fees = await withRpcRetry(() => client.estimateFeesPerGas());
  if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) {
    return {
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas * multiplier / 100n,
      maxFeePerGas: fees.maxFeePerGas * multiplier / 100n,
    };
  }
  return { gasPrice: await withRpcRetry(() => client.getGasPrice()) * multiplier / 100n };
}

function ensureGasBalance(
  nativeBalance: bigint,
  gas: bigint,
  fees: TransactionFeeOverrides,
  requiredUsdc = 0n,
) {
  const feePerGas = "gasPrice" in fees ? fees.gasPrice : fees.maxFeePerGas;
  const requiredNativeBalance = requiredNativeUsdcBalance(gas, feePerGas, requiredUsdc);
  if (nativeBalance < requiredNativeBalance) {
    throw new Error(requiredUsdc > 0n
      ? "Insufficient USDC balance for the amount and network gas."
      : "Insufficient native USDC balance for gas.");
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
  const verifiedWalletRpcRef = useRef("");
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
    if (!address || chainId !== arcChain.id || !publicClient) { setBalances(null); return; }
    if (background && balanceRefreshInFlightRef.current) return;
    balanceRefreshInFlightRef.current = true;
    if (!background) setBalanceLoading(true);
    setBalanceError(false);
    try {
      const [usdc, tokenBalance] = await Promise.all([
        withRpcRetry(() => publicClient.readContract({ address: ARC_ACTIVE_CONTRACTS.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] }), 2),
        withRpcRetry(() => publicClient.readContract({ address: token.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [address] }), 2),
      ]);
      setBalances({ usdc, token: tokenBalance });
    } catch { setBalanceError(true); } finally {
      balanceRefreshInFlightRef.current = false;
      if (!background) setBalanceLoading(false);
    }
  }, [address, chainId, publicClient, token.address]);

  useLiveRefresh({
    enabled: Boolean(address && chainId === arcChain.id && publicClient),
    intervalMs: BALANCE_POLL_INTERVAL_MS,
    refresh: () => refreshBalances(true),
  });

  useEffect(() => { const timer = window.setTimeout(() => void refreshBalances(), 1_000); return () => window.clearTimeout(timer); }, [refreshBalances]);
  useEffect(() => { setTransactionHash(null); setNotice(""); setNoticeIsError(false); }, [amount, side, slippageInput]);
  useEffect(() => { verifiedWalletRpcRef.current = ""; }, [address, chainId, walletClient]);

  async function getClient() {
    if (!isConnected || !address) throw new Error("Connect a wallet before trading.");
    if (chainId !== arcChain.id) { await switchChainAsync({ chainId: arcChain.id }); throw new Error(`${arcChain.name} is now selected. Submit again.`); }
    if (!publicClient) throw new Error(`No ${arcChain.name} public client is available.`);
    return publicClient;
  }

  async function ensureWalletRpcReady() {
    if (!walletClient || !address) throw new Error("The connected wallet is not ready. Reconnect it and retry.");
    const checkKey = `${address.toLowerCase()}:${arcChain.id}`;
    if (verifiedWalletRpcRef.current === checkKey) return;
    const walletReadClient = walletClient.extend(publicActions) as unknown as PublicClient;
    try {
      await walletReadClient.getTransactionCount({ address, blockTag: "latest" });
      verifiedWalletRpcRef.current = checkKey;
      return;
    } catch (error) {
      const decision = walletRpcPreflightDecision(error);
      if (decision === "continue") {
        // All nonce, balance, fee and simulation reads below use ArcOrigin's
        // failover client. A temporary limit on the wallet's read transport
        // must not block a fully prepared transaction from reaching the wallet.
        verifiedWalletRpcRef.current = checkKey;
        return;
      }
      if (decision === "fail") throw error;
    }

    setNotice(`Your wallet has an outdated Arc RPC. Approve the network update to ${ARC_WALLET_RPC_URL}.`);
    setNoticeIsError(false);
    try {
      await walletClient.addChain({ chain: arcChain });
    } catch (error) {
      if (/User rejected|User denied|rejected the request/i.test(rpcErrorText(error))) throw error;
      // Some wallets report "already added" instead of updating in place.
      // Switching and rechecking below still succeeds when they accepted the new RPC.
    }
    await walletClient.switchChain({ id: arcChain.id });
    // Injected connectors can retain their old read transport after the wallet
    // accepts a network update. Do not immediately probe that cached endpoint
    // again; writeContract receives an explicit nonce, gas and fee configuration.
    verifiedWalletRpcRef.current = checkKey;
    setNotice("");
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
      quotedAt: Date.now(),
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
      const client = await getClient();
      await ensureWalletRpcReady();
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
      const [currentBalance, allowance] = await Promise.all([
        withRpcRetry(() => client.readContract({ address: approvalToken, abi: erc20Abi, functionName: "balanceOf", args: [address] })),
        withRpcRetry(() => client.readContract({ address: approvalToken, abi: erc20Abi, functionName: "allowance", args: [address, executionQuote.spender] })),
      ]);
      if (currentBalance < executionQuote.input) throw new Error(`Insufficient ${inputSymbol} balance.`);
      if (allowance < executionQuote.input) {
        setStatus("approving");
        const approvalArgs = [executionQuote.spender, executionQuote.input] as const;
        const [estimatedApprovalGas, approvalFees, approvalNativeBalance, approvalNonce] = await Promise.all([
          withRpcRetry(() => client.estimateContractGas({
            account: address,
            address: approvalToken,
            abi: erc20Abi,
            functionName: "approve",
            args: approvalArgs,
          })),
          estimatePriorityFees(client as PublicClient, priority),
          withRpcRetry(() => client.getBalance({ address })),
          withRpcRetry(() => client.getTransactionCount({ address, blockTag: "pending" })),
        ]);
        const approvalGas = gasWithSafetyMargin(estimatedApprovalGas);
        ensureGasBalance(approvalNativeBalance, approvalGas, approvalFees, side === "Buy" ? executionQuote.input : 0n);
        const approvalHash = await writeContractAsync({ address: approvalToken, abi: erc20Abi, functionName: "approve", args: approvalArgs, gas: approvalGas, nonce: approvalNonce, ...approvalFees });
        setTransactionHash(approvalHash);
        if ((await withRpcRetry(() => client.waitForTransactionReceipt({ hash: approvalHash }))).status !== "success") throw new Error(`${inputSymbol} approval reverted onchain.`);
        setStatus("quoting");
        executionQuote = await readQuote();
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
      const [estimatedTradeGas, tradeFees, tradeNativeBalance, tradeNonce] = await Promise.all([
        withRpcRetry(() => client.estimateContractGas({
          account: address,
          address: ARC_UNISWAP_V3.router,
          abi: uniswapV3RouterAbi,
          functionName: "exactInputSingle",
          args: tradeArgs,
        })),
        estimatePriorityFees(client as PublicClient, priority),
        withRpcRetry(() => client.getBalance({ address })),
        withRpcRetry(() => client.getTransactionCount({ address, blockTag: "pending" })),
      ]);
      const tradeGas = gasWithSafetyMargin(estimatedTradeGas);
      ensureGasBalance(tradeNativeBalance, tradeGas, tradeFees, side === "Buy" ? executionQuote.input : 0n);
      setStatus("trading");
      const tradeHash = await writeContractAsync({
        address: ARC_UNISWAP_V3.router,
        abi: uniswapV3RouterAbi,
        functionName: "exactInputSingle",
        args: tradeArgs,
        gas: tradeGas,
        nonce: tradeNonce,
        ...tradeFees,
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
    <div className="mt-5 flex items-center justify-between gap-3"><label className="label mb-0 text-[15px]">You pay</label><div className="flex items-center gap-3"><button type="button" disabled={!balanceError || balanceLoading} onClick={() => void refreshBalances()} className={balanceError ? "text-sm text-cyan" : "text-sm text-slate-400"}>{balanceLabel}</button><span className="flex items-center gap-1 text-sm text-slate-400"><Settings2 className="size-4" />{slippageValid ? `${slippage}%` : "Invalid"} · {priority}</span></div></div>
    <div className="mt-2 flex items-center rounded-2xl bg-black/20 px-4 ring-1 ring-inset ring-line/70"><input inputMode="decimal" value={amount} disabled={isPending} onChange={(event) => acceptsTradeInput(event.target.value, inputDecimals) && setAmount(event.target.value)} className="h-14 min-w-0 flex-1 bg-transparent text-xl font-semibold outline-none" /><Badge tone="neutral">{inputSymbol}</Badge></div>
    {amountExceedsBalance && <p className="mt-2 text-sm text-rose-300">Amount exceeds your available {inputSymbol} balance.</p>}
    <div className="mt-2 grid grid-cols-5 gap-1">{percentageOptions.map((percent) => <button key={percent} type="button" disabled={isPending || !activeBalance} onClick={() => activeBalance !== undefined && setAmount(inputUnits(activeBalance * BigInt(percent) / 100n, inputDecimals))} className="h-9 rounded-full font-mono text-sm text-slate-400 disabled:opacity-60">{percent}%</button>)}</div>
    <div className="mt-4 border-y border-line/70 py-3"><div className="flex justify-between"><span className="text-slate-300">You receive</span><span className="font-mono font-semibold">{quoteLoading ? "Reading…" : liveQuote ? `${displayUnits(liveQuote.output, outputDecimals, side === "Buy" ? 0 : 6)} ${outputSymbol}` : `— ${outputSymbol}`}</span></div><div className="mt-2 flex justify-between text-sm text-slate-400"><span>Minimum received</span><span className="font-mono">{liveQuote ? `${displayUnits(liveQuote.minimumOutput, outputDecimals)} ${outputSymbol}` : "—"}</span></div>{quoteError && <p className="mt-2 text-sm text-amber-300">{quoteError}</p>}</div>
    <div className="mt-3 grid gap-3 py-2"><div className="flex items-start justify-between gap-3"><span className="pt-2 text-slate-300">Slippage</span><div className="flex flex-wrap justify-end gap-1">{slippageOptions.map((value) => <button key={value} type="button" disabled={isPending} onClick={() => setSlippageInput(String(value))} className={`h-9 rounded-full px-3 font-mono text-sm disabled:opacity-50 ${slippage === value ? "bg-cyan/12 text-cyan" : "text-slate-400"}`}>{value}%</button>)}<label className="flex h-9 w-[86px] items-center rounded-full border border-line px-2"><input aria-label="Custom slippage percentage" inputMode="decimal" value={slippageInput} disabled={isPending} onChange={(event) => /^\d{0,2}(?:\.\d{0,2})?$/.test(event.target.value) && setSlippageInput(event.target.value)} className="min-w-0 flex-1 bg-transparent text-right outline-none disabled:opacity-50" /><span>%</span></label></div></div><div className="flex items-center justify-between"><span className="text-slate-300">Priority</span><div className="flex gap-1">{priorityOptions.map((value) => <button key={value} type="button" onClick={() => setPriority(value)} className={`h-9 rounded-full px-3 text-sm ${priority === value ? "bg-cyan/12 text-cyan" : "text-slate-400"}`}>{value}</button>)}</div></div></div>
    <Button className="mt-4 w-full" disabled={tradeDisabled} onClick={() => void submitTrade()}>{actionLabel}</Button>
    {notice && <p role={noticeIsError ? "alert" : "status"} className={`mt-3 rounded-lg border p-3 text-sm ${noticeIsError ? "border-rose-400/20 text-rose-200" : "border-emerald-400/15 text-emerald-300"}`}>{notice}{transactionHash && <span className="ml-2"><ArcscanLink hash={transactionHash} label="View transaction" /></span>}</p>}
    <p className="mt-4 text-sm leading-6 text-slate-400">Trades execute through the canonical Uniswap V3 pool. The LP position cannot be withdrawn.</p>
  </div>;
}
