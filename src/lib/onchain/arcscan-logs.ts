import { isAddress, isHash, type Address, type Hash, type Hex } from "viem";
import { EXPLORER_URL } from "@/lib/chains";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_LOGS_PER_REQUEST = 1_000;

type ArcscanLogPayload = {
  address?: unknown;
  blockNumber?: unknown;
  data?: unknown;
  logIndex?: unknown;
  timeStamp?: unknown;
  topics?: unknown;
  transactionHash?: unknown;
};

type ArcscanResponse = {
  message?: unknown;
  result?: unknown;
  status?: unknown;
};

export type ArcscanLog = {
  address: Address;
  blockNumber: bigint;
  data: Hex;
  logIndex: number;
  timestamp: number;
  topics: [Hash, ...Hash[]];
  transactionHash: Hash;
};

function isHex(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

function isAddressValue(value: unknown): value is Address {
  return typeof value === "string" && isAddress(value);
}

function isHashValue(value: unknown): value is Hash {
  return typeof value === "string" && isHash(value);
}

function parseQuantity(value: unknown) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error("Arcscan returned an invalid log quantity.");
  }
  return BigInt(value);
}

function parseLog(value: unknown): ArcscanLog {
  if (!value || typeof value !== "object") throw new Error("Arcscan returned an invalid log.");
  const payload = value as ArcscanLogPayload;
  if (!isAddressValue(payload.address) || !isHex(payload.data) || !isHashValue(payload.transactionHash)) {
    throw new Error("Arcscan returned an invalid log identity.");
  }
  if (!Array.isArray(payload.topics)) {
    throw new Error("Arcscan returned invalid log topics.");
  }
  const topics = payload.topics.filter(isHashValue);
  if (topics.length === 0) throw new Error("Arcscan returned an empty log topic set.");
  return {
    address: payload.address,
    blockNumber: parseQuantity(payload.blockNumber),
    data: payload.data,
    logIndex: Number(parseQuantity(payload.logIndex)),
    timestamp: Number(parseQuantity(payload.timeStamp)),
    topics: topics as [Hash, ...Hash[]],
    transactionHash: payload.transactionHash,
  };
}

export async function getArcscanLogs({
  address,
  fromBlock,
  toBlock,
  topic0,
}: {
  address: Address;
  fromBlock: bigint;
  toBlock: bigint | "latest";
  topic0?: Hash;
}) {
  const url = new URL("/api", EXPLORER_URL);
  url.searchParams.set("module", "logs");
  url.searchParams.set("action", "getLogs");
  url.searchParams.set("fromBlock", fromBlock.toString());
  url.searchParams.set("toBlock", toBlock.toString());
  url.searchParams.set("address", address);
  if (topic0) url.searchParams.set("topic0", topic0);

  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Arcscan log request failed with HTTP ${response.status}.`);
  const payload = await response.json() as ArcscanResponse;
  if (payload.status === "0"
    && Array.isArray(payload.result)
    && payload.result.length === 0
    && typeof payload.message === "string"
    && /^No (?:records|logs) found$/i.test(payload.message.trim())) return [];
  if (payload.status !== "1" || !Array.isArray(payload.result)) {
    throw new Error("Arcscan log index is temporarily unavailable.");
  }
  if (payload.result.length >= MAX_LOGS_PER_REQUEST) {
    throw new Error("Arcscan log response reached its safe limit.");
  }
  const logs = payload.result.map(parseLog);
  const expectedAddress = address.toLowerCase();
  if (logs.some((log) => log.address.toLowerCase() !== expectedAddress
    || log.blockNumber < fromBlock
    || (toBlock !== "latest" && log.blockNumber > toBlock)
    || (topic0 && log.topics[0].toLowerCase() !== topic0.toLowerCase()))) {
    throw new Error("Arcscan returned a log outside the requested filter.");
  }
  return logs;
}
