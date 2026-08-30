"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ARC_ACTIVE_FACTORY, arcChain } from "@/lib/chains";
import { loadClientTokenIndex } from "@/lib/onchain/client-token-index";
import { loadIndexedMarketSnapshot } from "@/lib/onchain/market-event-snapshot";
import type { MarketSnapshot } from "@/lib/onchain/market-snapshot";
import { snapshotRevalidationDelay } from "@/lib/onchain/snapshot-revalidation";
import type { TokenData, Trade } from "@/lib/types";

const TOKEN_INDEX_CACHE_KEY =
  `arcorigin:${arcChain.id}:factory-index:${ARC_ACTIVE_FACTORY.toLowerCase()}`;
const LAST_CONFIRMED_LAUNCH_KEY = `arcorigin:${arcChain.id}:last-launch-confirmed-at`;
const PENDING_TRADES_KEY = `arcorigin:${arcChain.id}:confirmed-trades`;
const TOKEN_INDEX_CACHE_TTL = 6 * 60 * 60 * 1_000;
const PENDING_TRADE_TTL = 24 * 60 * 60 * 1_000;
const SNAPSHOT_REQUEST_TIMEOUT_MS = 12_000;
const MARKET_REQUEST_CONCURRENCY = 4;
const TRADE_FEED_LIMIT = 500;

type CachedIndex = { savedAt: number; marketDataComplete: true; tokens: TokenData[] };
type TokenIndexSnapshot = { tokens: TokenData[]; indexedBlock: string; generatedAt: string };
type ConfirmedTrade = {
  tokenAddress: string;
  transactionHash: string;
  side: "Buy" | "Sell";
  wallet: string;
  blockNumber: string;
  timestamp: number;
  usdc: number;
  fee: number;
  tokens: number;
};

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function isCachedToken(value: unknown): value is TokenData {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<TokenData>;
  return token.source === "onchain"
    && typeof token.name === "string"
    && typeof token.ticker === "string"
    && isAddress(token.address)
    && isAddress(token.poolAddress)
    && isAddress(token.creator)
    && typeof token.launchBlock === "number"
    && typeof token.launchTxHash === "string"
    && /^0x[0-9a-fA-F]{64}$/.test(token.launchTxHash)
    && typeof token.price === "number"
    && Number.isFinite(token.price)
    && typeof token.marketCap === "number"
    && Number.isFinite(token.marketCap)
    && Array.isArray(token.chartData)
    && Array.isArray(token.recentTrades)
    && Array.isArray(token.riskLabels)
    && Boolean(token.creatorProfile);
}

function normalizeTokenImage(token: TokenData): TokenData {
  return token.image?.startsWith("https://ipfs.io/ipfs/")
    ? { ...token, image: token.image.replace("https://ipfs.io/ipfs/", "https://gateway.pinata.cloud/ipfs/") }
    : token;
}

function isConfirmedTrade(value: unknown): value is ConfirmedTrade {
  if (!value || typeof value !== "object") return false;
  const trade = value as Partial<ConfirmedTrade>;
  return isAddress(trade.tokenAddress)
    && isAddress(trade.wallet)
    && typeof trade.transactionHash === "string"
    && /^0x[0-9a-fA-F]{64}$/.test(trade.transactionHash)
    && (trade.side === "Buy" || trade.side === "Sell")
    && typeof trade.blockNumber === "string"
    && /^\d+$/.test(trade.blockNumber)
    && typeof trade.timestamp === "number"
    && Number.isFinite(trade.timestamp)
    && trade.timestamp > 0
    && typeof trade.usdc === "number"
    && Number.isFinite(trade.usdc)
    && trade.usdc >= 0
    && typeof trade.fee === "number"
    && Number.isFinite(trade.fee)
    && trade.fee >= 0
    && typeof trade.tokens === "number"
    && Number.isFinite(trade.tokens)
    && trade.tokens > 0;
}

function readPendingTrades() {
  try {
    const raw = window.localStorage.getItem(PENDING_TRADES_KEY);
    if (!raw) return [];
    const cutoff = Math.floor((Date.now() - PENDING_TRADE_TTL) / 1_000);
    return (JSON.parse(raw) as unknown[])
      .filter(isConfirmedTrade)
      .filter((trade) => trade.timestamp >= cutoff)
      .slice(0, 50);
  } catch {
    return [];
  }
}

function rememberConfirmedTrade(trade: ConfirmedTrade) {
  try {
    const trades = [
      trade,
      ...readPendingTrades().filter((item) => item.transactionHash.toLowerCase() !== trade.transactionHash.toLowerCase()),
    ].slice(0, 50);
    window.localStorage.setItem(PENDING_TRADES_KEY, JSON.stringify(trades));
  } catch {
    // Live state still updates when browser storage is unavailable.
  }
}

function mergeConfirmedTrade(token: TokenData, confirmed: ConfirmedTrade): TokenData {
  if (token.address.toLowerCase() !== confirmed.tokenAddress.toLowerCase()) return token;
  if (token.recentTrades.some((trade) => trade.txHash.toLowerCase() === confirmed.transactionHash.toLowerCase())) {
    return token;
  }
  const trade: Trade = {
    time: `Block ${confirmed.blockNumber}`,
    timestamp: confirmed.timestamp,
    type: confirmed.side,
    wallet: confirmed.wallet,
    usdc: confirmed.usdc,
    tokens: confirmed.tokens,
    price: confirmed.usdc / confirmed.tokens,
    txHash: confirmed.transactionHash,
  };
  const isWithin24Hours = confirmed.timestamp >= Math.floor(Date.now() / 1_000) - 24 * 60 * 60;
  return {
    ...token,
    volume24h: token.volume24h + (isWithin24Hours ? confirmed.usdc : 0),
    buyers: token.buyers + (isWithin24Hours && confirmed.side === "Buy" ? 1 : 0),
    sellers: token.sellers + (isWithin24Hours && confirmed.side === "Sell" ? 1 : 0),
    trades: token.trades + 1,
    recentTrades: [trade, ...token.recentTrades].slice(0, TRADE_FEED_LIMIT),
    creatorProfile: {
      ...token.creatorProfile,
      totalVolume: token.creatorProfile.totalVolume + (isWithin24Hours ? confirmed.usdc : 0),
    },
  };
}

function mergePendingTrades(tokens: TokenData[]) {
  return readPendingTrades().reduce(
    (current, trade) => current.map((token) => mergeConfirmedTrade(token, trade)),
    tokens,
  );
}

function readCachedIndex(): CachedIndex | null {
  try {
    const raw = window.localStorage.getItem(TOKEN_INDEX_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedIndex>;
    if (typeof parsed.savedAt !== "number" || !Number.isFinite(parsed.savedAt) || parsed.savedAt <= 0) return null;
    if (parsed.marketDataComplete !== true) return null;
    if (!Array.isArray(parsed.tokens) || parsed.tokens.length > 100 || !parsed.tokens.every(isCachedToken)) return null;
    const tokens = mergePendingTrades(parsed.tokens.map(normalizeTokenImage));
    return { savedAt: parsed.savedAt, marketDataComplete: true, tokens };
  } catch {
    return null;
  }
}

function writeCachedIndex(tokens: TokenData[]) {
  try {
    const snapshot: CachedIndex = {
      savedAt: Date.now(),
      marketDataComplete: true,
      tokens,
    };
    window.localStorage.setItem(TOKEN_INDEX_CACHE_KEY, JSON.stringify(snapshot));
    return snapshot.savedAt;
  } catch {
    return null;
  }
}

function applySnapshot(token: TokenData, snapshot: MarketSnapshot): TokenData {
  const launchedAt = token.launchedAt ?? snapshot.chart.find((point) => point.timestamp)?.timestamp;
  return {
    ...token,
    launchedAt,
    ageMinutes: launchedAt ? Math.max(0, Math.floor((Date.now() / 1_000 - launchedAt) / 60)) : token.ageMinutes,
    price: snapshot.price,
    priceChange24h: snapshot.priceChange,
    marketCap: snapshot.marketCap,
    raisedUSDC: snapshot.raisedUsdc,
    targetUSDC: snapshot.targetUsdc,
    volume5m: 0,
    volume1h: 0,
    volume24h: snapshot.volume,
    buyers: snapshot.buyers,
    sellers: snapshot.sellers,
    trades: snapshot.trades.length,
    holders: token.holders,
    crossProgress: snapshot.progress,
    status: snapshot.crossed ? "Crossed" : "Live",
    chartData: snapshot.chart,
    recentTrades: snapshot.trades,
    creatorProfile: { ...token.creatorProfile, totalVolume: snapshot.volume },
  };
}

function preserveMarketValues(base: TokenData, previous?: TokenData) {
  if (!previous) return base;
  return {
    ...base,
    price: previous.price,
    priceChange24h: previous.priceChange24h,
    marketCap: previous.marketCap,
    raisedUSDC: previous.raisedUSDC,
    volume5m: previous.volume5m,
    volume1h: previous.volume1h,
    volume24h: previous.volume24h,
    buyers: previous.buyers,
    sellers: previous.sellers,
    trades: previous.trades,
    holders: previous.holders,
    crossProgress: previous.crossProgress,
    status: previous.status,
    chartData: previous.chartData,
    recentTrades: previous.recentTrades,
    creatorProfile: {
      ...base.creatorProfile,
      totalVolume: previous.creatorProfile.totalVolume,
    },
  } satisfies TokenData;
}

async function loadServerSnapshot<T>(path: string): Promise<{ snapshot: T; stale: boolean }> {
  try {
    const response = await fetch(path, {
      cache: path.includes("refresh=1") ? "no-store" : "default",
      signal: AbortSignal.timeout(SNAPSHOT_REQUEST_TIMEOUT_MS),
    });
    const payload = await response.json() as { snapshot?: T; stale?: boolean; error?: string };
    if (!response.ok || !payload.snapshot) throw new Error(payload.error ?? "Onchain snapshot is unavailable.");
    return { snapshot: payload.snapshot, stale: Boolean(payload.stale) };
  } catch {
    throw new Error("Live data is temporarily unavailable.");
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += concurrency) {
    results.push(...await Promise.all(items.slice(index, index + concurrency).map(worker)));
  }
  return results;
}

async function loadFactoryTokens(
  includeMarketData: boolean,
  forceRefresh: boolean,
  onIndexLoaded?: (tokens: TokenData[], stale: boolean) => void,
  onMarketLoaded?: (
    tokens: TokenData[],
    marketDataError: unknown,
    stale: boolean,
    failedMarketAddresses: ReadonlySet<string>,
  ) => void,
) {
  const indexPath = `/api/onchain/tokens${forceRefresh ? "?refresh=1" : ""}`;
  let indexResult: { snapshot: TokenIndexSnapshot; stale: boolean };
  try {
    indexResult = await loadServerSnapshot<TokenIndexSnapshot>(indexPath);
  } catch {
    indexResult = {
      snapshot: await loadClientTokenIndex((snapshot) => onIndexLoaded?.(snapshot.tokens, false)),
      stale: false,
    };
  }
  const indexedTokens = indexResult.snapshot.tokens.map(normalizeTokenImage);
  if (!includeMarketData) {
    return {
      tokens: indexedTokens,
      marketDataError: null,
      stale: indexResult.stale,
      failedMarketAddresses: new Set<string>(),
    };
  }
  onIndexLoaded?.(indexedTokens, indexResult.stale);

  let marketDataError: unknown;
  const failedMarketAddresses = new Set<string>();
  const marketTokens = await mapWithConcurrency(indexedTokens, MARKET_REQUEST_CONCURRENCY, async (base) => {
    const refreshQuery = forceRefresh ? "?refresh=1" : "";
    try {
      const marketResult = await loadServerSnapshot<MarketSnapshot>(`/api/onchain/tokens/${base.address}/market${refreshQuery}`);
      return applySnapshot(base, marketResult.snapshot);
    } catch (loadError) {
      try {
        const snapshot = await loadIndexedMarketSnapshot(base);
        return applySnapshot(base, snapshot);
      } catch (fallbackError) {
        marketDataError ??= fallbackError ?? loadError;
        failedMarketAddresses.add(base.address.toLowerCase());
        return base;
      }
    }
  });
  onMarketLoaded?.(marketTokens, marketDataError, indexResult.stale, failedMarketAddresses);
  return { tokens: marketTokens, marketDataError, stale: indexResult.stale, failedMarketAddresses };
}

export function useFactoryTokenIndex({ includeMarketData = true, allowCache = true }: { includeMarketData?: boolean; allowCache?: boolean } = {}) {
  const [tokens, setTokens] = useState<TokenData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isCached, setIsCached] = useState(false);
  const [isPartial, setIsPartial] = useState(false);
  const [marketDataReady, setMarketDataReady] = useState(false);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const refreshRequestRef = useRef(0);
  const staleRevalidationAttemptRef = useRef(0);

  const refresh = useCallback(async (forceRefresh = true) => {
    const requestId = ++refreshRequestRef.current;
    const isCurrentRequest = () => refreshRequestRef.current === requestId;
    setLoading(true);
    setError("");
    try {
      const result = await loadFactoryTokens(
        includeMarketData,
        forceRefresh,
        (indexedTokens, stale) => {
          if (!isCurrentRequest()) return;
          setTokens((current) => {
            return mergePendingTrades(indexedTokens.map((token) => preserveMarketValues(
              token,
              current.find((item) => item.address.toLowerCase() === token.address.toLowerCase()),
            )));
          });
          setIsPartial(false);
          setIsCached(stale);
        },
        (marketTokens, marketDataError, stale, failedMarketAddresses) => {
          if (!isCurrentRequest()) return;
          setTokens((current) => mergePendingTrades(marketTokens.map((token) => (
            failedMarketAddresses.has(token.address.toLowerCase())
              ? preserveMarketValues(token, current.find((item) => item.address.toLowerCase() === token.address.toLowerCase()))
              : token
          ))));
          setIsPartial(Boolean(marketDataError));
          setIsCached(stale);
          setLoading(false);
        },
      );
      if (!isCurrentRequest()) return;
      setTokens((current) => {
        const next = mergePendingTrades(result.tokens.map((token) => (
          !includeMarketData || result.failedMarketAddresses.has(token.address.toLowerCase())
            ? preserveMarketValues(token, current.find((item) => item.address.toLowerCase() === token.address.toLowerCase()))
            : token
        )));
        if (allowCache && !result.marketDataError) {
          writeCachedIndex(next);
        }
        return next;
      });
      setIsPartial(Boolean(result.marketDataError));
      setIsCached(result.stale);
      if (!result.marketDataError) setMarketDataReady(true);
      if (result.marketDataError) {
        setError("Live market refresh is delayed. Confirm trade amounts with the onchain quote.");
      }
    } catch (loadError) {
      if (!isCurrentRequest()) return;
      const message = loadError instanceof AggregateError
        ? "Live refresh is temporarily unavailable. The last confirmed launch list remains visible."
        : loadError instanceof Error
          ? loadError.message
          : String(loadError);
      setIsPartial(false);
      setError(message || `Factory launch data could not be refreshed from ${arcChain.name}.`);
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [allowCache, includeMarketData]);

  useEffect(() => {
    let forceInitialRefresh = true;
    if (allowCache) {
      const cached = readCachedIndex();
      if (cached) {
        setTokens(cached.tokens);
        setIsCached(true);
        setIsPartial(false);
        setMarketDataReady(true);
        setCachedAt(cached.savedAt);
        const lastConfirmedLaunchAt = Number(window.localStorage.getItem(LAST_CONFIRMED_LAUNCH_KEY) ?? 0);
        forceInitialRefresh = cached.tokens.length === 0
          || Date.now() - cached.savedAt > TOKEN_INDEX_CACHE_TTL
          || lastConfirmedLaunchAt > cached.savedAt;
      }
    }
    void refresh(forceInitialRefresh);
    const handleLaunch = () => void refresh(true);
    const reconciliationTimers: ReturnType<typeof setTimeout>[] = [];
    const reconcileToken = async (tokenAddress: string) => {
      if (!includeMarketData) return;
      try {
        const marketResult = await loadServerSnapshot<MarketSnapshot>(
          `/api/onchain/tokens/${tokenAddress}/market?refresh=1`,
        );
        setTokens((current) => mergePendingTrades(current.map((token) => (
          token.address.toLowerCase() === tokenAddress.toLowerCase()
            ? applySnapshot(token, marketResult.snapshot)
            : token
        ))));
      } catch {
        // Keep the confirmed optimistic trade visible until the index catches up.
      }
    };
    const handleTrade = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isConfirmedTrade(detail)) return;
      rememberConfirmedTrade(detail);
      if (includeMarketData) {
        setTokens((current) => {
          const next = current.map((token) => mergeConfirmedTrade(token, detail));
          if (allowCache && readCachedIndex()) setCachedAt(writeCachedIndex(next));
          return next;
        });
        for (const delay of [1_500, 5_000, 12_000]) {
          reconciliationTimers.push(setTimeout(() => void reconcileToken(detail.tokenAddress), delay));
        }
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (!includeMarketData || event.key !== PENDING_TRADES_KEY) return;
      const pendingTrades = readPendingTrades();
      setTokens((current) => mergePendingTrades(current));
      const latestTrade = pendingTrades[0];
      if (latestTrade) void reconcileToken(latestTrade.tokenAddress);
    };
    window.addEventListener("arcforge:launch-confirmed", handleLaunch);
    window.addEventListener("arcforge:trade-confirmed", handleTrade);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("arcforge:launch-confirmed", handleLaunch);
      window.removeEventListener("arcforge:trade-confirmed", handleTrade);
      window.removeEventListener("storage", handleStorage);
      reconciliationTimers.forEach(clearTimeout);
    };
  }, [allowCache, includeMarketData, refresh]);

  useEffect(() => {
    if (!isCached) {
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
  }, [isCached, loading, refresh]);

  return { tokens, loading, error, refresh, isCached, isPartial, marketDataReady, cachedAt };
}
