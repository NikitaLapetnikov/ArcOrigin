"use client";

import { useCallback, useEffect, useState } from "react";
import { ARCORIGIN_V4_GRADUATION_TARGET_USDC, ARC_TESTNET_V4_FACTORY } from "@/lib/chains";
import { loadClientTokenIndex } from "@/lib/onchain/client-token-index";
import { loadIndexedMarketSnapshot } from "@/lib/onchain/market-event-snapshot";
import type { MarketSnapshot } from "@/lib/onchain/market-snapshot";
import { getVerifiedBootstrapTokens } from "@/lib/onchain/verified-bootstrap-tokens";
import type { TokenData } from "@/lib/types";

const TOKEN_INDEX_CACHE_KEY = "arcorigin:5042002:factory-index-v7";
const TOKEN_INDEX_CACHE_TTL = 6 * 60 * 60 * 1_000;
const SNAPSHOT_REQUEST_TIMEOUT_MS = 12_000;

type CachedIndex = { savedAt: number; tokens: TokenData[] };
type TokenIndexSnapshot = { tokens: TokenData[]; indexedBlock: string; generatedAt: string };

function isCurrentV4Token(token: TokenData) {
  return token.factoryAddress?.toLowerCase() === ARC_TESTNET_V4_FACTORY.toLowerCase()
    && Math.abs(token.targetUSDC - ARCORIGIN_V4_GRADUATION_TARGET_USDC) < 0.000001
    && Math.abs(token.creatorAllocationPercent ?? 0) < 0.000001;
}

function currentV4Tokens(tokens: TokenData[]) {
  return tokens.filter(isCurrentV4Token);
}

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
    && isAddress(token.curveAddress)
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

function readCachedIndex(): CachedIndex | null {
  try {
    const raw = window.localStorage.getItem(TOKEN_INDEX_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedIndex>;
    if (typeof parsed.savedAt !== "number" || Date.now() - parsed.savedAt > TOKEN_INDEX_CACHE_TTL) return null;
    if (!Array.isArray(parsed.tokens) || parsed.tokens.length > 100 || !parsed.tokens.every(isCachedToken)) return null;
    const tokens = currentV4Tokens(parsed.tokens);
    return { savedAt: parsed.savedAt, tokens };
  } catch {
    return null;
  }
}

function writeCachedIndex(tokens: TokenData[]) {
  try {
    const snapshot: CachedIndex = { savedAt: Date.now(), tokens: currentV4Tokens(tokens) };
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
    curveProgress: snapshot.progress,
    status: snapshot.graduated ? "Graduated" : snapshot.progress >= 75 ? "Graduating soon" : "Live on curve",
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
    curveProgress: previous.curveProgress,
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
  const response = await fetch(path, { signal: AbortSignal.timeout(SNAPSHOT_REQUEST_TIMEOUT_MS) });
  const payload = await response.json() as { snapshot?: T; stale?: boolean; error?: string };
  if (!response.ok || !payload.snapshot) throw new Error(payload.error ?? "Onchain snapshot is unavailable.");
  return { snapshot: payload.snapshot, stale: Boolean(payload.stale) };
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
  onMarketLoaded?: (tokens: TokenData[], marketDataError: unknown, stale: boolean) => void,
) {
  const indexPath = `/api/onchain/tokens${forceRefresh ? "?refresh=1" : ""}`;
  let indexResult: { snapshot: TokenIndexSnapshot; stale: boolean };
  try {
    indexResult = await loadServerSnapshot<TokenIndexSnapshot>(indexPath);
  } catch {
    indexResult = {
      snapshot: await loadClientTokenIndex((snapshot) => onIndexLoaded?.(currentV4Tokens(snapshot.tokens), false)),
      stale: false,
    };
  }
  const indexedTokens = currentV4Tokens(indexResult.snapshot.tokens);
  if (!includeMarketData) return { tokens: indexedTokens, marketDataError: null, stale: indexResult.stale };
  onIndexLoaded?.(indexedTokens, indexResult.stale);

  let marketDataError: unknown;
  const marketTokens = await mapWithConcurrency(indexedTokens, 2, async (base) => {
    const refreshQuery = forceRefresh ? "?refresh=1" : "";
    try {
      const marketResult = await loadServerSnapshot<MarketSnapshot>(`/api/onchain/tokens/${base.address}/market${refreshQuery}`);
      return applySnapshot(base, marketResult.snapshot);
    } catch (loadError) {
      try {
        const snapshot = await loadIndexedMarketSnapshot(base, BigInt(indexResult.snapshot.indexedBlock));
        return applySnapshot(base, snapshot);
      } catch (fallbackError) {
        marketDataError ??= fallbackError ?? loadError;
        return base;
      }
    }
  });
  onMarketLoaded?.(marketTokens, marketDataError, indexResult.stale);
  return { tokens: marketTokens, marketDataError, stale: indexResult.stale };
}

export function useFactoryTokenIndex({ includeMarketData = true, allowCache = true }: { includeMarketData?: boolean; allowCache?: boolean } = {}) {
  const [tokens, setTokens] = useState<TokenData[]>(() => currentV4Tokens(getVerifiedBootstrapTokens()));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isCached, setIsCached] = useState(false);
  const [isPartial, setIsPartial] = useState(false);
  const [cachedAt, setCachedAt] = useState<number | null>(null);

  const refresh = useCallback(async (forceRefresh = true) => {
    setLoading(true);
    setError("");
    try {
      const result = await loadFactoryTokens(
        includeMarketData,
        forceRefresh,
        (indexedTokens, stale) => {
          setTokens((current) => indexedTokens.map((token) => preserveMarketValues(
            token,
            current.find((item) => item.address.toLowerCase() === token.address.toLowerCase()),
          )));
          setIsPartial(false);
          setIsCached(stale);
        },
        (marketTokens, marketDataError, stale) => {
          setTokens(marketTokens);
          setIsPartial(Boolean(marketDataError));
          setIsCached(stale);
          setLoading(false);
        },
      );
      setTokens(result.tokens);
      setIsPartial(Boolean(result.marketDataError));
      setIsCached(result.stale);
      if (allowCache && includeMarketData) setCachedAt(writeCachedIndex(result.tokens));
      if (result.marketDataError) {
        const message = result.marketDataError instanceof Error ? result.marketDataError.message : String(result.marketDataError);
        setError(`Factory launches are confirmed, but some market values could not be refreshed. ${message}`);
      } else if (result.stale) {
        setError("Showing the latest confirmed Factory snapshot while Arc Testnet RPC recovers.");
      }
    } catch (loadError) {
      const message = loadError instanceof AggregateError
        ? "Live refresh is temporarily unavailable. The last confirmed launch list remains visible."
        : loadError instanceof Error
          ? loadError.message
          : String(loadError);
      setIsPartial(false);
      setError(message || "Factory launch data could not be refreshed from Arc Testnet.");
    } finally {
      setLoading(false);
    }
  }, [allowCache, includeMarketData]);

  useEffect(() => {
    if (allowCache) {
      const cached = readCachedIndex();
      if (cached) {
        setTokens(cached.tokens);
        setIsCached(true);
        setIsPartial(false);
        setCachedAt(cached.savedAt);
      }
    }
    void refresh(false);
    const handleRefresh = () => void refresh(true);
    window.addEventListener("arcforge:launch-confirmed", handleRefresh);
    window.addEventListener("arcforge:trade-confirmed", handleRefresh);
    return () => {
      window.removeEventListener("arcforge:launch-confirmed", handleRefresh);
      window.removeEventListener("arcforge:trade-confirmed", handleRefresh);
    };
  }, [allowCache, includeMarketData, refresh]);

  return { tokens, loading, error, refresh, isCached, isPartial, cachedAt };
}
