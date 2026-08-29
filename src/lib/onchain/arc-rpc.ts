import { createPublicClient, fallback, http } from "viem";
import { arcChain } from "@/lib/chains";

export function arcRpcUrls(preferred?: string) {
  return [...new Set([preferred, ...arcChain.rpcUrls.default.http].filter((url): url is string => Boolean(url)))];
}

export function createArcPublicClient(
  preferred?: string,
  timeout = 8_000,
  retryCount = 1,
) {
  return createPublicClient({
    chain: arcChain,
    transport: fallback(
      arcRpcUrls(preferred).map((url) => http(url, {
        retryCount,
        retryDelay: 250,
        timeout,
      })),
      { rank: false, retryCount: 0 },
    ),
  });
}
