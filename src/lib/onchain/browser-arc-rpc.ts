import { createPublicClient, http } from "viem";
import { arcChain } from "@/lib/chains";

export const ARC_RPC_RELAY_URL = "https://arcorigin.xyz/api/onchain/rpc";
export const arcWalletChain = {
  ...arcChain,
  rpcUrls: {
    default: { http: [ARC_RPC_RELAY_URL, ...arcChain.rpcUrls.default.http] },
  },
} as typeof arcChain;

export function createBrowserArcReadClient() {
  return createPublicClient({
    chain: arcChain,
    transport: http("/api/onchain/rpc", {
      retryCount: 2,
      retryDelay: 250,
      timeout: 10_000,
    }),
  });
}
