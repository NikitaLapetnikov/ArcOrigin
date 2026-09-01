import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { nativeUsdcToPrecompileBalance } from "@/lib/arc-usdc";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import { getStoredWalletBalances } from "@/lib/server/event-store";
import { requestClientKey } from "@/lib/server/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ address: string }> };

const balanceClient = createArcPublicClient(process.env.ARC_MAINNET_RPC_URL, 4_000, 1);
const BALANCE_CACHE_TTL_MS = 4_000;
const MAX_BALANCE_CACHE_ENTRIES = 256;
const BALANCE_RATE_WINDOW_MS = 60_000;
const MAX_BALANCE_READS_PER_WINDOW = 120;
const nativeBalanceCache = new Map<string, { balance: bigint; expiresAt: number }>();
const balanceRates = new Map<string, { startedAt: number; count: number }>();

function consumeBalanceRate(clientKey: string) {
  const now = Date.now();
  const current = balanceRates.get(clientKey);
  if (!current || now - current.startedAt >= BALANCE_RATE_WINDOW_MS) {
    if (balanceRates.size >= 2_000) {
      for (const [key, rate] of balanceRates) {
        if (now - rate.startedAt >= BALANCE_RATE_WINDOW_MS) balanceRates.delete(key);
      }
      if (balanceRates.size >= 2_000) {
        const oldestKey = balanceRates.keys().next().value;
        if (oldestKey) balanceRates.delete(oldestKey);
      }
    }
    balanceRates.set(clientKey, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= MAX_BALANCE_READS_PER_WINDOW) return false;
  current.count += 1;
  return true;
}

async function readNativeBalance(address: `0x${string}`) {
  const key = address.toLowerCase();
  const cached = nativeBalanceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.balance;
  if (cached) nativeBalanceCache.delete(key);
  const balance = await balanceClient.getBalance({ address });
  if (nativeBalanceCache.size >= MAX_BALANCE_CACHE_ENTRIES) {
    const oldestKey = nativeBalanceCache.keys().next().value;
    if (oldestKey) nativeBalanceCache.delete(oldestKey);
  }
  nativeBalanceCache.set(key, { balance, expiresAt: Date.now() + BALANCE_CACHE_TTL_MS });
  return balance;
}

export async function GET(request: NextRequest, context: RouteContext) {
  if (!consumeBalanceRate(requestClientKey(request))) {
    return NextResponse.json({ error: "Too many balance requests. Retry shortly." }, {
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": "10" },
    });
  }
  const { address } = await context.params;
  if (!isAddress(address)) {
    return NextResponse.json({ error: "Invalid wallet address." }, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const normalizedAddress = getAddress(address);
  const [result, nativeBalanceResult] = await Promise.all([
    getStoredWalletBalances(normalizedAddress),
    readNativeBalance(normalizedAddress).then(
      (balance) => ({ status: "fulfilled" as const, balance }),
      () => ({ status: "rejected" as const }),
    ),
  ]);
  if (!result) {
    return NextResponse.json({ error: "Indexed wallet balances are temporarily unavailable." }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return NextResponse.json({
    nativeBalance: nativeBalanceResult.status === "fulfilled"
      ? nativeBalanceResult.balance.toString()
      : null,
    usdcBalance: nativeBalanceResult.status === "fulfilled"
      ? nativeUsdcToPrecompileBalance(nativeBalanceResult.balance).toString()
      : null,
    balances: result.balances.map((balance) => ({
      tokenAddress: balance.tokenAddress,
      balance: balance.balance.toString(),
    })),
    checkpoint: result.checkpoint,
  }, {
    headers: { "Cache-Control": "no-store" },
  });
}
