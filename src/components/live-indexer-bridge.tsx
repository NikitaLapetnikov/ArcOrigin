"use client";

import { useEffect } from "react";
import { isLiveIndexerEvent, tradeDetailFromIndexerEvent } from "@/lib/indexer/live-event";

const DEDUPE_LIMIT = 500;

/**
 * Maintains one SSE connection for the entire app and translates canonical
 * indexer events into the existing local reconciliation events. EventSource
 * reconnects automatically; existing polling remains active as a fallback.
 */
export function LiveIndexerBridge() {
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource("/api/onchain/events");
    const seen = new Set<string>();
    const handleEvent = (message: MessageEvent<string>) => {
      try {
        const event: unknown = JSON.parse(message.data);
        if (!isLiveIndexerEvent(event) || seen.has(event.id)) return;
        seen.add(event.id);
        if (seen.size > DEDUPE_LIMIT) {
          const oldest = seen.values().next().value as string | undefined;
          if (oldest) seen.delete(oldest);
        }
        window.dispatchEvent(new CustomEvent("arcorigin:indexer-event", { detail: event }));
        if (event.kind === "launch") {
          window.dispatchEvent(new CustomEvent("arcforge:launch-confirmed", { detail: event }));
        } else if (event.kind === "swap") {
          const trade = tradeDetailFromIndexerEvent(event);
          if (trade) window.dispatchEvent(new CustomEvent("arcforge:trade-confirmed", { detail: trade }));
        } else if (event.kind === "holder_change") {
          window.dispatchEvent(new CustomEvent("arcorigin:holder-event", { detail: event }));
        } else if (event.kind === "buyback") {
          window.dispatchEvent(new CustomEvent("arcorigin:buyback-event", { detail: event }));
        }
      } catch {
        // Invalid or partial events are ignored; polling will reconcile state.
      }
    };
    source.addEventListener("arc-event", handleEvent as EventListener);
    return () => {
      source.removeEventListener("arc-event", handleEvent as EventListener);
      source.close();
    };
  }, []);
  return null;
}
