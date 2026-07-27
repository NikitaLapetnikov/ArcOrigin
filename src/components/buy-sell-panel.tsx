"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import {
  decodeEventLog,
  formatUnits,
  parseUnits,
  publicActions,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import {
  useAccount,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
  useWriteContract,
} from "wagmi";
import { ARC_TESTNET_CONTRACTS, arcTestnet } from "@/lib/chains";
import { usesPermanentLiquidityMode } from "@/lib/bonding-curve";
import { bondingCurveAbi, erc20Abi } from "@/lib/contracts";
import type { TokenData } from "@/lib/types";
import { tickerLabel } from "@/lib/utils";
import { ArcscanLink, Badge, Button } from "./ui";

type Side = "Buy" | "Sell";
type Priority = "Low" | "Medium" | "High";
type LiveQuote = { input: bigint; output: bigint; fee: bigint; minimumOutput: bigint };
type TransactionStatus = "idle" | "quoting" | "preparing" | "approving" | "trading";
type WalletBalances = { usdc: bigint; token: bigint };
type TransactionFeeOverrides = {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};
const percentageOptions = [10, 25, 50, 75, 100] as const;
const slippageOptions = [10, 20, 40] as const;
const priorityOptions: Priority[] = ["Low", "Medium", "High"];
const MAX_SLIPPAGE_PERCENT = 50;

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withRpcRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /RPC Request failed|HTTP request failed|fetch failed|Too Many Requests|rate limit|\b429\b/i.test(message);
      if (!retryable || attempt === attempts) throw error;
      await wait(attempt * 750);
    }
  }
  throw new Error("Arc RPC request failed after retries.");
}

function transactionError(error: unknown) {
  const message = typeof error === "object" && error && "shortMessage" in error
    ? String(error.shortMessage)
    : error instanceof Error
      ? error.message
      : "The wallet transaction failed.";
  if (/RPC Request failed|HTTP request failed|fetch failed|Too Many Requests|\b429\b/i.test(message)) {
    return "Arc RPC is temporarily unavailable. Check your wallet activity or Arcscan before retrying because the transaction may already have been submitted.";
  }
  if (/User rejected|User denied|rejected the request/i.test(message)) return "The request was cancelled in your wallet.";
  return message;
}

function displayUnits(value: bigint, decimals: number) {
  const parsed = Number(formatUnits(value, decimals));
  return Number.isFinite(parsed)
    ? parsed.toLocaleString("en-US", { maximumFractionDigits: decimals === 6 ? 6 : 4 })
    : "—";
}

function inputUnits(value: bigint, decimals: number) {
  const formatted = formatUnits(value, decimals);
  const trimmed = formatted.includes(".") ? formatted.replace(/\.?0+$/, "") : formatted;
  return trimmed || "0";
}

async function estimatePriorityFees(client: PublicClient, priority: Priority): Promise<TransactionFeeOverrides> {
  try {
    const multiplier = priority === "Low" ? 100n : priority === "High" ? 150n : 110n;
    const fees = await client.estimateFeesPerGas();
    const maxPriorityFeePerGas = fees.maxPriorityFeePerGas === undefined
      ? undefined
      : fees.maxPriorityFeePerGas * multiplier / 100n;
    const maxFeePerGas = fees.maxFeePerGas === undefined
      ? undefined
      : fees.maxFeePerGas * multiplier / 100n;
    return { maxFeePerGas, maxPriorityFeePerGas };
  } catch {
    // A connected wallet can safely estimate its own fee if the public RPC does not expose fee history.
    return {};
  }
}

export function BuySellPanel({ token }: { token: TokenData }) {
  if (token.curveAddress) {
    return <LiveBuySellPanel token={token} curveAddress={token.curveAddress as Address} />;
  }
  return <div id="trade-panel" className="panel scroll-mt-28 p-5"><Badge tone="warn">Onchain data unavailable</Badge><p className="mt-4 text-sm leading-6 text-slate-400">The indexed Factory event did not include a usable bonding-curve address. Trading is disabled.</p></div>;
}

function LiveBuySellPanel({ token, curveAddress }: { token: TokenData; curveAddress: Address }) {
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
  const balanceRequestRef = useRef(0);
  const quoteRequestRef = useRef(0);
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const inputDecimals = side === "Buy" ? 6 : 18;
  const inputSymbol = side === "Buy" ? "USDC" : tickerLabel(token.ticker);
  const isPending = status !== "idle";
  const permanentLiquidityMode = usesPermanentLiquidityMode(token.virtualUsdcReserve, token.targetUSDC);
  const buyDisabled = side === "Buy" && token.status === "Graduated" && !permanentLiquidityMode;
  const activeBalance = side === "Buy" ? balances?.usdc : balances?.token;
  const slippage = Number(slippageInput);
  const slippageValid = Number.isFinite(slippage)
    && slippage > 0
    && slippage <= MAX_SLIPPAGE_PERCENT;
  const refreshBalances = useCallback(async () => {
    const requestId = ++balanceRequestRef.current;
    if (!address || chainId !== arcTestnet.id) {
      setBalances(null);
      setBalanceLoading(false);
      setBalanceError(false);
      return;
    }
    const account = address;
    const walletReadClient = walletClient?.chain.id === arcTestnet.id
      ? walletClient.extend(publicActions) as unknown as PublicClient
      : null;
    const clients = [walletReadClient, publicClient].filter((client): client is PublicClient => Boolean(client));
    if (clients.length === 0) return;
    setBalanceLoading(true);
    setBalanceError(false);
    try {
      async function readBalance(contractAddress: Address) {
        let lastError: unknown;
        for (const client of clients) {
          try {
            return await withRpcRetry(() => client.readContract({
              address: contractAddress,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [account],
            }), 2);
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError ?? new Error("No Arc Testnet balance client is available.");
      }
      const usdc = await readBalance(ARC_TESTNET_CONTRACTS.usdc);
      await wait(180);
      const tokenBalance = await readBalance(token.address as Address);
      if (balanceRequestRef.current === requestId) setBalances({ usdc, token: tokenBalance });
    } catch {
      if (balanceRequestRef.current === requestId) {
        setBalances(null);
        setBalanceError(true);
      }
    } finally {
      if (balanceRequestRef.current === requestId) setBalanceLoading(false);
    }
  }, [address, chainId, publicClient, token.address, walletClient]);

  useEffect(() => {
    setTransactionHash(null);
    setNotice("");
    setNoticeIsError(false);
  }, [amount, side, slippageInput]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void refreshBalances(), 1_500);
    return () => window.clearTimeout(timeout);
  }, [refreshBalances]);

  useEffect(() => {
    if (!balanceError) return;
    const timeout = window.setTimeout(() => void refreshBalances(), 12_000);
    return () => window.clearTimeout(timeout);
  }, [balanceError, refreshBalances]);

  function selectBalancePercent(percent: (typeof percentageOptions)[number]) {
    if (activeBalance === undefined) return;
    const selected = activeBalance * BigInt(percent) / 100n;
    setAmount(inputUnits(selected, inputDecimals));
  }

  async function getClient() {
    if (!isConnected || !address) throw new Error("Connect a wallet before requesting an onchain quote.");
    if (chainId !== arcTestnet.id) {
      await switchChainAsync({ chainId: arcTestnet.id });
      throw new Error("Arc Testnet is now selected. Request the quote again.");
    }
    const client = walletClient?.extend(publicActions) ?? publicClient;
    if (!client) throw new Error("No Arc Testnet client is available.");
    return client;
  }

  const readQuote = useCallback(async (): Promise<LiveQuote> => {
    if (buyDisabled) throw new Error("New buys are closed after graduation. Existing holders can still sell against the remaining USDC reserve.");
    if (!slippageValid) throw new Error(`Slippage must be greater than 0% and no more than ${MAX_SLIPPAGE_PERCENT}%.`);
    const input = parseUnits(amount, inputDecimals);
    if (input <= 0n) throw new Error("Enter an amount greater than zero.");
    const response = await fetch(
      `/api/onchain/quote?curve=${encodeURIComponent(curveAddress)}&side=${side}&amount=${input.toString()}`,
      { cache: "no-store", signal: AbortSignal.timeout(8_000) },
    );
    const result = await response.json() as { output?: string; fee?: string; error?: string };
    if (!response.ok || !result.output || result.fee === undefined) {
      throw new Error(result.error || "Unable to read an onchain quote.");
    }
    const output = BigInt(result.output);
    const fee = BigInt(result.fee);
    if (output <= 0n) {
      if (side === "Buy" && permanentLiquidityMode && token.status !== "Graduated") {
          const client = publicClient;
          if (!client) throw new Error("The Arc quote service is temporarily unavailable.");
          const maximum = await withRpcRetry(() => client.readContract({
          address: curveAddress,
          abi: bondingCurveAbi,
          functionName: "maxBuyAmount",
        }));
        throw new Error(`This input exceeds the remaining curve capacity. Maximum buy: ${displayUnits(maximum, 6)} USDC.`);
      }
      throw new Error(side === "Sell" ? "The curve has insufficient USDC reserves for this sale." : "The curve returned zero tokens.");
    }
    const slippageBps = BigInt(Math.round(slippage * 100));
    return {
      input,
      output,
      fee,
      minimumOutput: output * (10_000n - slippageBps) / 10_000n,
    };
  }, [
    amount,
    buyDisabled,
    curveAddress,
    inputDecimals,
    permanentLiquidityMode,
    publicClient,
    side,
    slippage,
    slippageValid,
    token.status,
  ]);

  useEffect(() => {
    const requestId = ++quoteRequestRef.current;
    setLiveQuote(null);
    setQuoteError("");
    if (!publicClient || !slippageValid || buyDisabled || !amount || Number(amount) <= 0) {
      setQuoteLoading(false);
      return;
    }

    setQuoteLoading(true);
    const timeout = window.setTimeout(() => {
      void readQuote()
        .then((quote) => {
          if (quoteRequestRef.current === requestId) setLiveQuote(quote);
        })
        .catch(() => {
          if (quoteRequestRef.current === requestId) {
            setLiveQuote(null);
            setQuoteError("Quote temporarily unavailable. Retry in a moment.");
          }
        })
        .finally(() => {
          if (quoteRequestRef.current === requestId) setQuoteLoading(false);
        });
    }, 300);

    return () => window.clearTimeout(timeout);
  }, [amount, buyDisabled, publicClient, readQuote, side, slippageInput, slippageValid]);

  async function submitTrade() {
    if (!address) {
      setNotice("Connect a wallet to trade.");
      setNoticeIsError(true);
      return;
    }
    if (submissionLockRef.current) return;
    submissionLockRef.current = true;
    setStatus("quoting");
    setNotice("");
    setNoticeIsError(false);
    setTransactionHash(null);
    try {
      const client = await getClient();
      const quote = await readQuote();
      setStatus("preparing");
      const approvalToken = (side === "Buy" ? ARC_TESTNET_CONTRACTS.usdc : token.address) as Address;
      const allowance = await withRpcRetry(() => client.readContract({
        address: approvalToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, curveAddress],
      }));
      if (allowance < quote.input) {
        setStatus("approving");
        const approvalFeeOverrides = await estimatePriorityFees(client as PublicClient, priority);
        const approvalHash = await writeContractAsync({
          address: approvalToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [curveAddress, quote.input],
          ...approvalFeeOverrides,
        });
        const approvalReceipt = await withRpcRetry(() => client.waitForTransactionReceipt({ hash: approvalHash }));
        if (approvalReceipt.status !== "success") throw new Error(`${inputSymbol} approval reverted onchain.`);
      }

      setStatus("trading");
      const tradeFeeOverrides = await estimatePriorityFees(client as PublicClient, priority);
      const tradeHash = side === "Buy"
        ? await writeContractAsync({
            address: curveAddress,
            abi: bondingCurveAbi,
            functionName: "buy",
            args: [quote.input, quote.minimumOutput],
            ...tradeFeeOverrides,
          })
        : await writeContractAsync({
            address: curveAddress,
            abi: bondingCurveAbi,
            functionName: "sell",
            args: [quote.input, quote.minimumOutput],
            ...tradeFeeOverrides,
          });
      setTransactionHash(tradeHash);
      const receipt = await withRpcRetry(() => client.waitForTransactionReceipt({ hash: tradeHash }));
      if (receipt.status !== "success") throw new Error(`${side} transaction reverted onchain.`);
      let confirmedTrade: {
        wallet: Address;
        usdc: bigint;
        tokens: bigint;
        fee: bigint;
      } | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== curveAddress.toLowerCase()) continue;
        try {
          if (side === "Buy") {
            const event = decodeEventLog({
              abi: bondingCurveAbi,
              eventName: "TokenBought",
              data: log.data,
              topics: log.topics,
            });
            confirmedTrade = {
              wallet: event.args.buyer,
              usdc: event.args.usdcIn,
              tokens: event.args.tokensOut,
              fee: event.args.fee,
            };
          } else {
            const event = decodeEventLog({
              abi: bondingCurveAbi,
              eventName: "TokenSold",
              data: log.data,
              topics: log.topics,
            });
            confirmedTrade = {
              wallet: event.args.seller,
              usdc: event.args.usdcOut,
              tokens: event.args.tokensIn,
              fee: event.args.fee,
            };
          }
          break;
        } catch {
          // Receipts also contain ERC-20 transfers and fee-vault events.
        }
      }
      if (!confirmedTrade) throw new Error("Trade confirmed, but its curve event was not found.");
      let confirmedAt = Math.floor(Date.now() / 1_000);
      try {
        const block = await withRpcRetry(
          () => (client as PublicClient).getBlock({ blockNumber: receipt.blockNumber }),
          2,
        );
        confirmedAt = Number(block.timestamp);
      } catch {
        // The confirmed block number remains authoritative if timestamp lookup is rate-limited.
      }
      setTransactionHash(tradeHash);
      setNotice(`${side} confirmed on Arc Testnet.`);
      setNoticeIsError(false);
      window.dispatchEvent(new CustomEvent("arcforge:trade-confirmed", {
        detail: {
          tokenAddress: token.address,
          transactionHash: tradeHash,
          side,
          wallet: confirmedTrade.wallet,
          blockNumber: receipt.blockNumber.toString(),
          timestamp: confirmedAt,
          usdc: Number(formatUnits(confirmedTrade.usdc, 6)),
          fee: Number(formatUnits(confirmedTrade.fee, 6)),
          tokens: Number(formatUnits(confirmedTrade.tokens, 18)),
        },
      }));
      void refreshBalances();
    } catch (error) {
      setNotice(transactionError(error));
      setNoticeIsError(true);
    } finally {
      submissionLockRef.current = false;
      setStatus("idle");
    }
  }

  const actionLabel = status === "quoting"
    ? "Reading curve…"
    : status === "preparing"
      ? "Preparing transaction…"
      : status === "approving"
        ? `Approving ${inputSymbol}…`
        : status === "trading"
          ? `${side} pending…`
          : buyDisabled
            ? "Buying closed at graduation"
            : `${side} ${tickerLabel(token.ticker)}`;

  const balanceLabel = !address
    ? "Connect wallet"
    : chainId !== arcTestnet.id
      ? "Switch to Arc Testnet"
      : balanceLoading
        ? "Reading balance…"
        : activeBalance === undefined
          ? balanceError ? "Balance unavailable · Retry" : "Balance unavailable"
          : `Balance ${displayUnits(activeBalance, inputDecimals)} ${inputSymbol}`;
  const outputDecimals = side === "Buy" ? 18 : 6;
  const outputSymbol = side === "Buy" ? tickerLabel(token.ticker) : "USDC";

  return <div id="trade-panel" className="panel scroll-mt-28 rounded-xl p-4 shadow-none">
    <div className="-mx-4 -mt-4 mb-4 flex items-center justify-between border-b border-line bg-black/10 px-4 py-3">
      <div><p className="text-base font-semibold text-white">Trade {tickerLabel(token.ticker)}</p><p className="mt-0.5 text-[13px] font-medium uppercase tracking-[.08em] text-slate-500">Bonding curve</p></div>
      <p className="text-[13px] font-medium uppercase tracking-[.08em] text-slate-500">Arc Testnet</p>
    </div>
    <div className="grid grid-cols-2 gap-1 rounded-xl bg-black/25 p-1">{(["Buy", "Sell"] as const).map((item) => <button key={item} disabled={isPending} onClick={() => setSide(item)} className={`h-9 rounded-lg text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${side === item ? item === "Buy" ? "bg-emerald-400/15 text-emerald-300" : "bg-rose-400/15 text-rose-300" : "text-slate-500"}`}>{item}</button>)}</div>
    <div className="mt-5 flex items-center justify-between gap-3"><label className="label mb-0 text-[15px]">You pay</label><div className="flex items-center gap-3"><button type="button" disabled={!balanceError || balanceLoading} onClick={() => void refreshBalances()} className={`max-w-[170px] truncate text-sm disabled:cursor-default ${balanceError ? "text-cyan" : "text-slate-400"}`} title={balanceLabel}>{balanceLabel}</button><span className="flex items-center gap-1 text-sm text-slate-400"><Settings2 className="size-4" />{slippageValid ? `${slippage}%` : "Invalid"} · {priority}</span></div></div>
    <div className="mt-2 flex items-center rounded-xl border border-line bg-[#080c13] px-3 focus-within:border-cyan/50"><input inputMode="decimal" value={amount} disabled={isPending} onChange={(event) => setAmount(event.target.value)} className="h-14 min-w-0 flex-1 bg-transparent text-xl font-semibold outline-none disabled:opacity-50" /><Badge tone="neutral">{inputSymbol}</Badge></div>
    <div className="mt-2 grid grid-cols-5 gap-1">{percentageOptions.map((percent) => <button key={percent} type="button" disabled={isPending || activeBalance === undefined || activeBalance === 0n} onClick={() => selectBalancePercent(percent)} className="h-9 rounded-lg border border-line bg-black/15 font-mono text-sm text-slate-300 transition hover:border-cyan/35 hover:text-cyan disabled:cursor-not-allowed disabled:opacity-35">{percent}%</button>)}</div>
    <div className="mt-3 rounded-xl border border-cyan/15 bg-cyan/[.04] p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-medium text-slate-300">You receive</span>
        <span className="text-right font-mono text-base font-semibold text-white">
          {quoteLoading ? "Reading…" : liveQuote ? `${displayUnits(liveQuote.output, outputDecimals)} ${outputSymbol}` : `— ${outputSymbol}`}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-sm text-slate-400">
        <span>Minimum received</span>
        <span className="font-mono">{liveQuote ? `${displayUnits(liveQuote.minimumOutput, outputDecimals)} ${outputSymbol}` : "—"}</span>
      </div>
      {quoteError && <p role="status" className="mt-2 text-sm text-amber-300">{quoteError}</p>}
    </div>
    <div className="mt-3 grid gap-3 rounded-xl border border-line bg-black/15 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] text-slate-300">Slippage</span>
        <div className="flex items-center gap-1">
          {slippageOptions.map((value) => <button
            key={value}
            type="button"
            disabled={isPending}
            onClick={() => setSlippageInput(String(value))}
            className={`h-9 rounded-md px-3 font-mono text-sm transition ${slippage === value ? "bg-cyan/12 text-cyan" : "text-slate-400 hover:bg-white/[.04] hover:text-slate-200"}`}
          >{value}%</button>)}
          <label className={`flex h-9 w-[86px] items-center rounded-md border px-2 font-mono text-sm ${
            slippageValid ? "border-line text-slate-300 focus-within:border-cyan/40" : "border-rose-400/40 text-rose-300"
          }`}>
            <input
              aria-label="Custom slippage percentage"
              inputMode="decimal"
              disabled={isPending}
              value={slippageInput}
              onChange={(event) => {
                const next = event.target.value.replace(",", ".");
                if (/^\d{0,2}(?:\.\d{0,2})?$/.test(next)) setSlippageInput(next);
              }}
              className="min-w-0 flex-1 bg-transparent text-right outline-none disabled:opacity-50"
            />
            <span className="ml-1 text-slate-500">%</span>
          </label>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] text-slate-300">Priority</span>
        <div className="flex gap-1">{priorityOptions.map((value) => <button
          key={value}
          type="button"
          disabled={isPending}
          onClick={() => setPriority(value)}
          className={`h-9 rounded-md px-3 text-sm transition ${priority === value ? "bg-cyan/12 text-cyan" : "text-slate-400 hover:bg-white/[.04] hover:text-slate-200"}`}
        >{value}</button>)}</div>
      </div>
    </div>
    <Button className="mt-4 w-full" disabled={isPending || buyDisabled || !slippageValid} onClick={() => void submitTrade()}>{actionLabel}</Button>
    {notice && <p role={noticeIsError ? "alert" : "status"} aria-live="polite" className={`mt-3 rounded-lg border p-3 text-sm leading-5 ${noticeIsError ? "border-rose-400/20 bg-rose-400/[.07] text-rose-200" : transactionHash ? "border-emerald-400/15 bg-emerald-400/[.07] text-emerald-300" : "border-cyan/15 bg-cyan/[.06] text-cyan"}`}>{notice}{transactionHash && <span className="ml-2"><ArcscanLink hash={transactionHash} label="View transaction" /></span>}</p>}
    <p className="mt-4 text-sm leading-6 text-slate-400">{token.status === "Graduated"
      ? permanentLiquidityMode
        ? "Graduated into a permanent real-reserve AMM. Both buys and sells continue."
        : "Buying is closed on this legacy curve after graduation. Selling remains available while the curve has USDC reserves."
      : `Trades execute against the deployed ${tickerLabel(token.ticker)} curve. Your wallet may request an exact-token approval first.`}</p>
  </div>;
}
