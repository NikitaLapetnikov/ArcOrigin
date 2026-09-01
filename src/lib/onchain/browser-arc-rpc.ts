import { createPublicClient, http } from "viem";
import { arcChain } from "@/lib/chains";

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
