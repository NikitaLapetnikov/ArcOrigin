"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { arcChain } from "@/lib/chains";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import type { BuybackSnapshot } from "@/lib/onchain/buyback-snapshot";

const STORAGE_PREFIX = `arcorigin:${arcChain.id}:buybacks:`;
const STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 12_000;
const pendingRequests = new Map<string, Promise<BuybackSnapshotResult>>();

type BuybackSnapshotResult = {
  snapshot: BuybackSnapshot;
  stale: boolean;
};

type CachedBuybackSnapshot = {
  savedAt: number;
  snapshot: BuybackSnapshot;
};

function storageKey(address: string) {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

function finiteNonNegative(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isAddress(value: unknown) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isExecution(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const execution = value as Partial<NonNullable<BuybackSnapshot["latestExecution"]>>;
  return typeof execution.txHash === "string"
    && /^0x[0-9a-fA-F]{64}$/.test(execution.txHash)
    && typeof execution.blockNumber === "string"
    && /^\d+$/.test(execution.blockNumber)
    && finiteNonNegative(execution.timestamp)
    && isAddress(execution.keeper)
    && finiteNonNegative(execution.usdcSpent)
    && finiteNonNegative(execution.keeperRewardUsdc)
    && finiteNonNegative(execution.tokensBurned);
}

function isKeeper(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const keeper = value as Partial<NonNullable<BuybackSnapshot["keeper"]>>;
  return isAddress(keeper.address)
    && finiteNonNegative(keeper.balanceUsdc)
    && typeof keeper.platform === "boolean";
}

function isSnapshot(value: unknown): value is BuybackSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<BuybackSnapshot>;
  return typeof snapshot.enabled === "boolean"
    && typeof snapshot.ready === "boolean"
    && finiteNonNegative(snapshot.reserveUsdc)
    && finiteNonNegative(snapshot.nextExecutionAt)
    && finiteNonNegative(snapshot.totalUsdcSpent)
    && finiteNonNegative(snapshot.totalTokensBurned)
    && Number.isInteger(snapshot.executionCount)
    && finiteNonNegative(snapshot.executionCount)
    && (snapshot.latestExecution === null || isExecution(snapshot.latestExecution))
    && (snapshot.keeper === null || isKeeper(snapshot.keeper))
    && typeof snapshot.indexedBlock === "string"
    && /^\d+$/.test(snapshot.indexedBlock)
    && typeof snapshot.generatedAt === "string"
    && Number.isFinite(Date.parse(snapshot.generatedAt));
}

function readCached(address: string): CachedBuybackSnapshot | null {
  try {
    const raw = window.localStorage.getItem(storageKey(address));
    if (!raw) return null;
    const cached = JSON.parse(raw) as Partial<CachedBuybackSnapshot>;
    if (typeof cached.savedAt !== "number"
      || Date.now() - cached.savedAt > STORAGE_TTL_MS
      || !isSnapshot(cached.snapshot)) return null;
    return { savedAt: cached.savedAt, snapshot: cached.snapshot };
  } catch {
    return null;
  }
}

function writeCached(address: string, snapshot: BuybackSnapshot) {
  const cached: CachedBuybackSnapshot = { savedAt: Date.now(), snapshot };
  try {
    window.localStorage.setItem(storageKey(address), JSON.stringify(cached));
  } catch {
    // A private browsing context may reject storage; the in-memory snapshot remains usable.
  }
  window.dispatchEvent(new CustomEvent("arcorigin:buybacks-updated", {
    detail: { address, cached },
  }));
  return cached;
}

function requestSnapshot(tokenAddress: string, forceRefresh: boolean) {
  const key = `${tokenAddress.toLowerCase()}:${forceRefresh ? "fresh" : "cached"}`;
  const existing = pendingRequests.get(key);
  if (existing) return existing;
  const request = fetch(`/api/onchain/tokens/${tokenAddress}/buybacks${forceRefresh ? "?refresh=1" : ""}`, {
    cache: forceRefresh ? "no-store" : "default",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).then(async (response) => {
    const payload = await response.json() as Partial<BuybackSnapshotResult> & { error?: string };
    if (!response.ok || !isSnapshot(payload.snapshot)) {
      throw new Error(payload.error ?? "Buyback data is unavailable.");
    }
    return { snapshot: payload.snapshot, stale: Boolean(payload.stale) };
  }).finally(() => pendingRequests.delete(key));
  pendingRequests.set(key, request);
  return request;
}

export function useBuybackSnapshot(
  tokenAddress: string,
  enabled: boolean,
  initialSnapshot: BuybackSnapshot | null = null,
) {
  const [snapshot, setSnapshot] = useState<BuybackSnapshot | null>(initialSnapshot);
  const [loading, setLoading] = useState(enabled && !initialSnapshot);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async (forceRefresh = false, background = false) => {
    if (!enabled || !tokenAddress) return;
    const requestId = ++requestIdRef.current;
    if (!background) setLoading(true);
    try {
      const result = await requestSnapshot(tokenAddress, forceRefresh);
      if (requestIdRef.current !== requestId) return;
      writeCached(tokenAddress, result.snapshot);
      setSnapshot(result.snapshot);
      setStale(result.stale);
      setError("");
    } catch (loadError) {
      if (requestIdRef.current !== requestId) return;
      setStale(true);
      setError(loadError instanceof Error ? loadError.message : "Buyback data is unavailable.");
    } finally {
      if (requestIdRef.current === requestId && !background) setLoading(false);
    }
  }, [enabled, tokenAddress]);

  useEffect(() => {
    if (!enabled || !tokenAddress) {
      setSnapshot(null);
      setLoading(false);
      setError("");
      setStale(false);
      return;
    }
    const cached = readCached(tokenAddress);
    const cachedGeneratedAt = cached ? Date.parse(cached.snapshot.generatedAt) || 0 : 0;
    const initialGeneratedAt = initialSnapshot ? Date.parse(initialSnapshot.generatedAt) || 0 : 0;
    const useCached = Boolean(cached && cachedGeneratedAt >= initialGeneratedAt);
    const immediateSnapshot = useCached ? cached?.snapshot ?? null : initialSnapshot;
    setSnapshot(immediateSnapshot);
    setLoading(!immediateSnapshot);
    setError("");
    setStale(useCached);
    if (initialSnapshot && !useCached) writeCached(tokenAddress, initialSnapshot);
    void refresh(false, Boolean(immediateSnapshot));

    const handleUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{
        address?: string;
        cached?: CachedBuybackSnapshot;
      }>).detail;
      if (detail.address?.toLowerCase() !== tokenAddress.toLowerCase() || !detail.cached) return;
      setSnapshot(detail.cached.snapshot);
    };
    const handleIndexerBuyback = (event: Event) => {
      const detail = (event as CustomEvent<{ tokenAddress?: string }>).detail;
      if (detail?.tokenAddress?.toLowerCase() !== tokenAddress.toLowerCase()) return;
      void refresh(true, true);
    };
    window.addEventListener("arcorigin:buybacks-updated", handleUpdate);
    window.addEventListener("arcorigin:buyback-event", handleIndexerBuyback);
    return () => {
      window.removeEventListener("arcorigin:buybacks-updated", handleUpdate);
      window.removeEventListener("arcorigin:buyback-event", handleIndexerBuyback);
    };
  }, [enabled, initialSnapshot, refresh, tokenAddress]);

  useLiveRefresh({
    intervalMs: 30_000,
    refresh: () => refresh(false, true),
    enabled,
  });

  return { snapshot, loading, error, stale, refresh };
}
