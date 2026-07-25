import { createPublicClient, fallback, http } from "viem";
import { arcTestnet } from "@/lib/chains";

export function arcRpcUrls(preferred?: string) {
  return [...new Set([preferred, ...arcTestnet.rpcUrls.default.http].filter((url): url is string => Boolean(url)))];
}

export function createArcPublicClient(preferred?: string, timeout = 8_000) {
  return createPublicClient({
    chain: arcTestnet,
    transport: fallback(
      arcRpcUrls(preferred).map((url) => http(url, { retryCount: 0, timeout })),
      { rank: false, retryCount: 0 },
    ),
  });
}
