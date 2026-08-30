"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isAddress, isHash } from "viem";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import type { LatestBuyRecord, LatestBuysSnapshot, Trade } from "@/lib/types";

const REQUEST_TIMEOUT_MS = 8_000;
const LATEST_BUY_LIMIT = 50;
const LATEST_BUYS_POLL_INTERVAL_MS = 8_000;

function isTrade(value: unknown): value is Trade {
  if (!value || typeof value !== "object") return false;
  const trade = value as Partial<Trade>;
  return trade.type === "Buy"
    && typeof trade.wallet === "string"
    && isAddress(trade.wallet)
    && typeof trade.usdc === "number"
    && Number.isFinite(trade.usdc)
    && trade.usdc >= 0
    && typeof trade.tokens === "number"
    && Number.isFinite(trade.tokens)
    && trade.tokens > 0
    && typeof trade.price === "number"
    && Number.isFinite(trade.price)
    && typeof trade.txHash === "string"
    && isHash(trade.txHash);
}

function isLatestBuysSnapshot(value: unknown): value is LatestBuysSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<LatestBuysSnapshot>;
  return Array.isArray(snapshot.buys)
    && snapshot.buys.length <= LATEST_BUY_LIMIT
    && snapshot.buys.every((record) => (
      record
      && typeof record === "object"
      && isAddress(record.tokenAddress)
      && isTrade(record.trade)
    ));
}

function mergeBuy(records: LatestBuyRecord[], next: LatestBuyRecord) {
  const normalizedHash = next.trade.txHash.toLowerCase();
  return [
    next,
    ...records.filter((record) => record.trade.txHash.toLowerCase() !== normalizedHash),
  ]
    .sort((left, right) => (right.trade.timestamp ?? 0) - (left.trade.timestamp ?? 0))
    .slice(0, LATEST_BUY_LIMIT);
}

export function useLatestBuys() {
  const [buys, setBuys] = useState<LatestBuyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const requestRef = useRef(0);
  const refreshInFlightRef = useRef(false);

  const refresh = useCallback(async (forceRefresh = false, background = false) => {
    if (background && refreshInFlightRef.current) return;
    const requestId = ++requestRef.current;
    refreshInFlightRef.current = true;
    if (!background) setLoading(true);
    try {
      const response = await fetch(`/api/onchain/latest-buys${forceRefresh ? "?refresh=1" : ""}`, {
        cache: forceRefresh ? "no-store" : "default",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const payload = await response.json() as { snapshot?: unknown };
      if (!response.ok || !isLatestBuysSnapshot(payload.snapshot)) {
        throw new Error("Latest buys are unavailable.");
      }
      if (requestId !== requestRef.current) return;
      setBuys(payload.snapshot.buys);
      setReady(true);
    } catch {
      // The full market snapshot remains a verified fallback.
    } finally {
      if (requestId === requestRef.current) {
        refreshInFlightRef.current = false;
        if (!background) setLoading(false);
      }
    }
  }, []);

  useLiveRefresh({
    intervalMs: LATEST_BUYS_POLL_INTERVAL_MS,
    refresh: () => refresh(true, true),
  });

  useEffect(() => {
    void refresh();
    const handleTrade = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object") return;
      const candidate = detail as {
        tokenAddress?: unknown;
        side?: unknown;
        wallet?: unknown;
        usdc?: unknown;
        tokens?: unknown;
        transactionHash?: unknown;
        timestamp?: unknown;
        blockNumber?: unknown;
      };
      if (
        candidate.side !== "Buy"
        || typeof candidate.tokenAddress !== "string"
        || !isAddress(candidate.tokenAddress)
        || typeof candidate.wallet !== "string"
        || !isAddress(candidate.wallet)
        || typeof candidate.transactionHash !== "string"
        || !isHash(candidate.transactionHash)
        || typeof candidate.usdc !== "number"
        || !Number.isFinite(candidate.usdc)
        || typeof candidate.tokens !== "number"
        || !Number.isFinite(candidate.tokens)
        || candidate.tokens <= 0
        || typeof candidate.timestamp !== "number"
        || !Number.isFinite(candidate.timestamp)
      ) return;
      const trade: Trade = {
        time: typeof candidate.blockNumber === "string" ? `Block ${candidate.blockNumber}` : "Confirmed",
        timestamp: candidate.timestamp,
        type: "Buy",
        wallet: candidate.wallet,
        usdc: candidate.usdc,
        tokens: candidate.tokens,
        price: candidate.usdc / candidate.tokens,
        txHash: candidate.transactionHash,
      };
      setBuys((current) => mergeBuy(current, { tokenAddress: candidate.tokenAddress as string, trade }));
      setReady(true);
      setLoading(false);
    };
    window.addEventListener("arcforge:trade-confirmed", handleTrade);
    return () => window.removeEventListener("arcforge:trade-confirmed", handleTrade);
  }, [refresh]);

  return { buys, loading, ready, refresh };
}
