import { createPublicClient, fallback, http } from "viem";
import { arcChain } from "@/lib/chains";

export function arcRpcUrls(preferred?: string) {
  const preferredUrls = (preferred ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  return [...new Set([...preferredUrls, ...arcChain.rpcUrls.default.http])];
}

export function arcQuoteRpcUrls(preferred?: string) {
  const quoteUrls = (process.env.ARC_MAINNET_QUOTE_RPC_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  return [...new Set([...quoteUrls, ...arcRpcUrls(preferred)])];
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
