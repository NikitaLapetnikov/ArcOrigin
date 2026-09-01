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
  };
}
