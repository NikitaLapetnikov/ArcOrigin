"use client";

import { useCallback, useEffect, useState } from "react";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import type { BuybackSnapshot } from "@/lib/onchain/buyback-snapshot";

export function useBuybackSnapshot(tokenAddress: string, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<BuybackSnapshot | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");

  const refresh = useCallback(async (forceRefresh = false, background = false) => {
    if (!enabled) return;
    if (!background) setLoading(true);
    try {
      const response = await fetch(`/api/onchain/tokens/${tokenAddress}/buybacks${forceRefresh ? "?refresh=1" : ""}`, {
        cache: forceRefresh ? "no-store" : "default",
        signal: AbortSignal.timeout(12_000),
      });
      const payload = await response.json() as { snapshot?: BuybackSnapshot; error?: string };
      if (!response.ok || !payload.snapshot) throw new Error(payload.error ?? "Buyback data is unavailable.");
      setSnapshot(payload.snapshot);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Buyback data is unavailable.");
    } finally {
      if (!background) setLoading(false);
    }
  }, [enabled, tokenAddress]);

  useEffect(() => { void refresh(); }, [refresh]);
  useLiveRefresh({ intervalMs: 30_000, refresh: () => refresh(true, true), enabled });

  return { snapshot, loading, error, refresh };
}
