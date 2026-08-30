"use client";

import { useEffect, useRef } from "react";

type LiveRefreshOptions = {
  enabled?: boolean;
  intervalMs: number;
  refresh: () => Promise<unknown> | unknown;
};

/**
 * Runs one non-overlapping refresh loop while the page is visible and online.
 * A foreground/network restore schedules an immediate refresh so throttled
 * browser timers never leave the UI stuck on an old snapshot.
 */
export function useLiveRefresh({ enabled = true, intervalMs, refresh }: LiveRefreshOptions) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    let stopped = false;
    let running = false;
    let timer: number | undefined;

    const schedule = (delay = intervalMs) => {
      if (stopped) return;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void run();
      }, delay);
    };

    const run = async () => {
      if (stopped || running) return;
      if (document.visibilityState === "hidden" || !window.navigator.onLine) {
        schedule();
        return;
      }
      running = true;
      try {
        await refreshRef.current();
      } catch {
        // Individual refresh functions surface their own recoverable state.
      } finally {
        running = false;
        schedule();
      }
    };

    const refreshNow = () => {
      if (document.visibilityState !== "visible" || !window.navigator.onLine || running) return;
      schedule(0);
    };

    schedule();
    window.addEventListener("focus", refreshNow);
    window.addEventListener("online", refreshNow);
    document.addEventListener("visibilitychange", refreshNow);
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("focus", refreshNow);
      window.removeEventListener("online", refreshNow);
      document.removeEventListener("visibilitychange", refreshNow);
    };
  }, [enabled, intervalMs]);
}
