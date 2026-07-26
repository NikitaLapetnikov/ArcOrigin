"use client";

import { useCallback, useEffect, useState } from "react";
import { factoryForLaunchBlock } from "@/lib/chains";
import type { HolderSnapshot } from "@/lib/onchain/holder-snapshot";
import type { TokenData } from "@/lib/types";

const STORAGE_PREFIX = "arcorigin:5042002:holders:";
const STORAGE_TTL_MS = 24 * 60 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const pendingRequests = new Map<string, Promise<HolderSnapshot>>();
const HOLDER_REFRESH_DELAYS_MS = [1_500, 5_000, 12_000] as const;

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

function applyConfirmedTransfer(
  snapshot: HolderSnapshot,
  token: TokenData,
  detail: { side: "Buy" | "Sell"; wallet: string; tokens: number; blockNumber?: string },
) {
  if (!token.curveAddress || !Number.isFinite(detail.tokens) || detail.tokens <= 0) return snapshot;
  const wallet = detail.wallet.toLowerCase();
  const curve = token.curveAddress.toLowerCase();
  const creator = token.creator.toLowerCase();
  const balances = new Map(snapshot.topHolders.map((holder) => [holder.address.toLowerCase(), Number(holder.balance)]));
  const walletWasKnown = balances.has(wallet);
  const walletBefore = balances.get(wallet) ?? 0;
  const curveBefore = balances.get(curve) ?? 0;
  const direction = detail.side === "Buy" ? 1 : -1;
  const walletAfter = Math.max(0, walletBefore + direction * detail.tokens);
  const curveAfter = Math.max(0, curveBefore - direction * detail.tokens);
  balances.set(wallet, walletAfter);
  balances.set(curve, curveAfter);

  const totalSupply = token.totalSupply ?? [...balances.values()].reduce((sum, balance) => sum + balance, 0);
  if (!Number.isFinite(totalSupply) || totalSupply <= 0) return snapshot;
  const percent = (balance: number) => balance / totalSupply * 100;
  const entries = [...balances.entries()]
    .filter(([, balance]) => balance > 0)
    .sort((left, right) => right[1] - left[1]);
  const topHolders: HolderSnapshot["topHolders"] = entries.slice(0, 100).map(([holderAddress, balance]) => ({
    address: holderAddress as `0x${string}`,
    balance: String(balance),
    percent: percent(balance),
    role: holderAddress === curve ? "Curve" : holderAddress === creator ? "Creator" : "Holder",
  }));
  const topTenExcludingCurvePercent = entries
    .filter(([address]) => address !== curve)
    .slice(0, 10)
    .reduce((sum, [, balance]) => sum + percent(balance), 0);
  let holders = snapshot.holders;
  if (detail.side === "Buy" && !walletWasKnown && snapshot.holders <= snapshot.topHolders.length) holders += 1;
  if (detail.side === "Sell" && walletWasKnown && walletBefore > 0 && walletAfter === 0) holders = Math.max(0, holders - 1);

  return {
    ...snapshot,
    holders,
    topHolders,
    creatorPercent: percent(balances.get(creator) ?? 0),
    curvePercent: percent(curveAfter),
    topTenExcludingCurvePercent,
    indexedBlock: detail.blockNumber ?? snapshot.indexedBlock,
    generatedAt: new Date().toISOString(),
  };
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
    cache: forceRefresh ? "no-store" : "default",
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
    if (autoRefresh) void refresh(false);
    const handleUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ address?: string; cached?: CachedHolderSnapshot }>).detail;
      if (detail.address?.toLowerCase() !== address.toLowerCase() || !detail.cached) return;
      setSnapshot(detail.cached.snapshot);
      setSavedAt(detail.cached.savedAt);
    };
    window.addEventListener("arcorigin:holders-updated", handleUpdate);
    return () => window.removeEventListener("arcorigin:holders-updated", handleUpdate);
  }, [address, autoRefresh, refresh]);

  useEffect(() => {
    if (!token || !address) return;
    const retryTimers: Array<ReturnType<typeof setTimeout>> = [];
    const handleTrade = (event: Event) => {
      const detail = (event as CustomEvent<{
        tokenAddress?: string;
        side?: "Buy" | "Sell";
        wallet?: string;
        tokens?: number;
        blockNumber?: string;
      }>).detail;
      if (detail?.tokenAddress?.toLowerCase() !== address.toLowerCase()
        || !detail.side
        || !detail.wallet
        || !detail.tokens) return;
      const side = detail.side;
      const wallet = detail.wallet;
      const tokens = detail.tokens;

      setSnapshot((current) => current ? applyConfirmedTransfer(current, token, {
        side,
        wallet,
        tokens,
        blockNumber: detail.blockNumber,
      }) : current);
      for (const delay of HOLDER_REFRESH_DELAYS_MS) {
        retryTimers.push(setTimeout(() => void refresh(true), delay));
      }
    };
    window.addEventListener("arcforge:trade-confirmed", handleTrade);
    return () => {
      window.removeEventListener("arcforge:trade-confirmed", handleTrade);
      retryTimers.forEach(clearTimeout);
    };
  }, [address, refresh, token]);

  return { snapshot, savedAt, loading, error, refresh };
}
