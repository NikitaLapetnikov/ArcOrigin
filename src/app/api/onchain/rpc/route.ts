import { NextRequest, NextResponse } from "next/server";
import { arcRpcUrls } from "@/lib/onchain/arc-rpc";
import { readLimitedText, requestClientKey } from "@/lib/server/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 300;
const RPC_TIMEOUT_MS = 7_000;
const ALLOWED_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_chainId",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_sendRawTransaction",
]);

type RateEntry = { startedAt: number; count: number };
declare global {
  var __arcOriginRpcRelayRates: Map<string, RateEntry> | undefined;
}
const rates = globalThis.__arcOriginRpcRelayRates ?? new Map<string, RateEntry>();
globalThis.__arcOriginRpcRelayRates = rates;

export function OPTIONS() {
  return new Response(null, { status: 204 });
}

function consumeRate(key: string, limit: number) {
  const now = Date.now();
  const current = rates.get(key);
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rates.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  if (rates.size > 2_000) {
    for (const [candidate, entry] of rates) {
      if (now - entry.startedAt >= RATE_WINDOW_MS) rates.delete(candidate);
    }
  }
  return true;
}

async function requestUpstream(url: string, body: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  const length = Number(response.headers.get("content-length") ?? 0);
  if (!response.ok || (length > 0 && length > MAX_RESPONSE_BYTES)) {
    throw new Error(`RPC upstream returned ${response.status}.`);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("RPC response is too large.");
  const payload: unknown = JSON.parse(text);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("RPC response is invalid.");
  const record = payload as Record<string, unknown>;
  if (record.jsonrpc !== "2.0" || (!("result" in record) && !("error" in record))) {
    throw new Error("RPC response is invalid.");
  }
  return payload;
}

export async function POST(request: NextRequest) {
  let body: string;
  let id: string | number | null = null;
  let method = "";
  try {
    body = await readLimitedText(request, MAX_BODY_BYTES);
    const payload = JSON.parse(body) as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    if (payload.jsonrpc !== "2.0"
      || (typeof payload.id !== "string" && typeof payload.id !== "number" && payload.id !== null)
      || typeof payload.method !== "string"
      || !ALLOWED_METHODS.has(payload.method)
      || !Array.isArray(payload.params)) {
      return NextResponse.json({ jsonrpc: "2.0", id: payload.id ?? null, error: { code: -32600, message: "Invalid or unsupported RPC request." } }, { status: 400 });
    }
    id = payload.id;
    method = payload.method;
    if (method === "eth_sendRawTransaction"
      && (payload.params.length !== 1
        || typeof payload.params[0] !== "string"
        || !/^0x[0-9a-fA-F]+$/.test(payload.params[0])
        || payload.params[0].length > 24_000)) {
      return NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid signed transaction payload." } }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32700, message: "Invalid JSON-RPC payload." } }, { status: 400 });
  }

  const rateKey = `${requestClientKey(request)}:${method === "eth_sendRawTransaction" ? "send" : "read"}`;
  if (!consumeRate(rateKey, method === "eth_sendRawTransaction" ? 30 : RATE_LIMIT)) {
    return NextResponse.json({ jsonrpc: "2.0", id, error: { code: -32005, message: "Arc RPC relay rate limit reached." } }, { status: 429 });
  }

  const urls = arcRpcUrls(process.env.ARC_MAINNET_RPC_URL);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await Promise.any(urls.map((url) => requestUpstream(url, body)));
      return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch {
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return NextResponse.json(
    { jsonrpc: "2.0", id, error: { code: -32005, message: "Arc RPC is temporarily unavailable." } },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "1" } },
  );
}
