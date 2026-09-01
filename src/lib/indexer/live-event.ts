import { isAddress, isHash } from "viem";

export type LiveIndexerEvent = {
  id: string;
  kind: "launch" | "swap" | "holder_change" | "buyback";
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  timestamp: number;
  tokenAddress: string;
  poolAddress?: string | null;
  [key: string]: unknown;
};

function payloadEventId(payload: string) {
  try {
    const parsed = JSON.parse(payload) as { id?: unknown };
    return typeof parsed.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}

/**
 * Redis stores live events newest-first. A fresh page already receives a
 * complete indexed snapshot, so replaying the whole buffer would duplicate
 * historical swaps and trigger unnecessary reconciliation. Only reconnects
 * with a known Last-Event-ID receive the events they actually missed.
 */
export function replayPayloadsAfter(recentNewestFirst: string[], lastEventId: string | null) {
  if (!lastEventId) {
    const cutoff = Math.floor(Date.now() / 1_000) - 5 * 60;
    const seen = new Set<string>();
    return recentNewestFirst.filter((payload) => {
      try {
        const event = JSON.parse(payload) as { id?: unknown; kind?: unknown; timestamp?: unknown };
        if (event.kind !== "launch" || typeof event.id !== "string" || typeof event.timestamp !== "number"
          || event.timestamp < cutoff || seen.has(event.id)) return false;
        seen.add(event.id);
        return true;
      } catch {
        return false;
      }
    }).reverse();
  }
  const lastSeenIndex = recentNewestFirst.findIndex(
    (payload) => payloadEventId(payload) === lastEventId,
  );
  if (lastSeenIndex <= 0) return [];
  return recentNewestFirst.slice(0, lastSeenIndex).reverse();
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

export function isLiveIndexerEvent(value: unknown): value is LiveIndexerEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<LiveIndexerEvent>;
  return typeof event.id === "string"
    && event.id.length > 0
    && (event.kind === "launch" || event.kind === "swap" || event.kind === "holder_change" || event.kind === "buyback")
    && typeof event.blockNumber === "string"
    && /^\d+$/.test(event.blockNumber)
    && typeof event.blockHash === "string"
    && isHash(event.blockHash)
    && typeof event.transactionHash === "string"
    && isHash(event.transactionHash)
    && Number.isInteger(event.logIndex)
    && finiteNumber(event.timestamp)
    && event.timestamp! >= 0
    && typeof event.tokenAddress === "string"
    && isAddress(event.tokenAddress)
    && (event.poolAddress === undefined || event.poolAddress === null || isAddress(event.poolAddress));
}

export function tradeDetailFromIndexerEvent(event: LiveIndexerEvent) {
  if (event.kind !== "swap"
    || (event.side !== "Buy" && event.side !== "Sell")
    || typeof event.wallet !== "string"
    || !isAddress(event.wallet)
    || !finiteNumber(event.usdc)
    || !finiteNumber(event.tokens)
    || Number(event.tokens) <= 0) return null;
  const executionPrice = finiteNumber(event.executionPrice) && Number(event.executionPrice) > 0
    ? Number(event.executionPrice)
    : undefined;
  return {
    tokenAddress: event.tokenAddress,
    transactionHash: event.transactionHash,
    side: event.side,
    wallet: event.wallet,
    blockNumber: event.blockNumber,
    timestamp: event.timestamp,
    usdc: Number(event.usdc),
    fee: 0,
    tokens: Number(event.tokens),
    ...(executionPrice === undefined ? {} : { executionPrice }),
  };
}
