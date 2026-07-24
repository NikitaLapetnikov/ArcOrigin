"use client";

import { useCallback, useEffect, useState } from "react";
import { factoryForLaunchBlock } from "@/lib/chains";
import type { HolderSnapshot } from "@/lib/onchain/holder-snapshot";
import type { TokenData } from "@/lib/types";

const STORAGE_PREFIX = "arcorigin:5042002:holders:";
const STORAGE_TTL_MS = 24 * 60 * 60 * 1_000;
const BACKGROUND_REFRESH_MS = 2 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const pendingRequests = new Map<string, Promise<HolderSnapshot>>();

type CachedHolderSnapshot = {
  savedAt: number;
  snapshot: HolderSnapshot;
};

function storageKey(address: string) {
  return `${STORAGE_PREFIX}${address.toLowerCase()}`;
}

function isSnapshot(value: unknown): value is HolderSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<HolderSnapshot>;
  return Number.isFinite(snapshot.holders)
    && Array.isArray(snapshot.topHolders)
    && snapshot.topHolders.every((holder) => holder
      && typeof holder.address === "string"
      && typeof holder.balance === "string"
      && Number.isFinite(holder.percent)
      && (holder.role === "Creator" || holder.role === "Curve" || holder.role === "Holder"))
    && Number.isFinite(snapshot.creatorPercent)
    && Number.isFinite(snapshot.curvePercent)
    && Number.isFinite(snapshot.permanentLiquidityLockPercent)
    && Number.isFinite(snapshot.topTenExcludingCurvePercent)
    && typeof snapshot.indexedBlock === "string"
    && typeof snapshot.generatedAt === "string";
}

function readCached(address: string): CachedHolderSnapshot | null {
  try {
    const raw = window.localStorage.getItem(storageKey(address));
    if (!raw) return null;
    const cached = JSON.parse(raw) as Partial<CachedHolderSnapshot>;
    if (typeof cached.savedAt !== "number"
      || Date.now() - cached.savedAt > STORAGE_TTL_MS
      || !isSnapshot(cached.snapshot)) return null;
    return { savedAt: cached.savedAt, snapshot: cached.snapshot };
  } catch {
    return null;
  }
}

function writeCached(address: string, snapshot: HolderSnapshot) {
  const cached: CachedHolderSnapshot = { savedAt: Date.now(), snapshot };
  try {
    window.localStorage.setItem(storageKey(address), JSON.stringify(cached));
  } catch {
    // A private browsing context can reject storage; the in-memory result remains usable.
  }
  window.dispatchEvent(new CustomEvent("arcorigin:holders-updated", {
    detail: { address, cached },
  }));
  return cached;
}

async function requestSnapshot(token: TokenData, forceRefresh: boolean) {
  const address = token.address;
  const key = address.toLowerCase();
  const existing = pendingRequests.get(key);
  if (existing) return existing;
  const query = new URLSearchParams();
  if (forceRefresh) query.set("refresh", "1");
  if (token.curveAddress && token.creator && token.launchBlock !== undefined) {
    query.set("factory", token.factoryAddress ?? factoryForLaunchBlock(token.launchBlock));
    query.set("curve", token.curveAddress);
    query.set("creator", token.creator);
    query.set("launchBlock", String(token.launchBlock));
  }
  const request = fetch(`/api/onchain/tokens/${address}/holders?${query.toString()}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).then(async (response) => {
    const payload = await response.json() as { snapshot?: HolderSnapshot; error?: string };
    if (!response.ok || !payload.snapshot) throw new Error(payload.error ?? "Holder analytics are temporarily unavailable.");
    return payload.snapshot;
  }).finally(() => pendingRequests.delete(key));
  pendingRequests.set(key, request);
  return request;
}

export function useHolderSnapshot(token: TokenData | undefined, autoRefresh = false) {
  const address = token?.address ?? "";
  const [snapshot, setSnapshot] = useState<HolderSnapshot | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async (forceRefresh = false) => {
    if (!token || !address) return;
    setLoading(true);
    setError("");
    try {
      const next = await requestSnapshot(token, forceRefresh);
      const cached = writeCached(address, next);
      setSnapshot(next);
      setSavedAt(cached.savedAt);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Holder analytics are temporarily unavailable.");
    } finally {
      setLoading(false);
    }
  }, [address, token]);

  useEffect(() => {
    if (!address) {
      setSnapshot(null);
      setSavedAt(0);
      return;
    }
    const cached = readCached(address);
    if (cached) {
      setSnapshot(cached.snapshot);
      setSavedAt(cached.savedAt);
    } else {
      setSnapshot(null);
      setSavedAt(0);
    }
    if (autoRefresh && (!cached || Date.now() - cached.savedAt > BACKGROUND_REFRESH_MS)) {
      void refresh(false);
    }
    const handleUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ address?: string; cached?: CachedHolderSnapshot }>).detail;
      if (detail.address?.toLowerCase() !== address.toLowerCase() || !detail.cached) return;
      setSnapshot(detail.cached.snapshot);
      setSavedAt(detail.cached.savedAt);
    };
    window.addEventListener("arcorigin:holders-updated", handleUpdate);
    return () => window.removeEventListener("arcorigin:holders-updated", handleUpdate);
  }, [address, autoRefresh, refresh]);

  return { snapshot, savedAt, loading, error, refresh };
}
