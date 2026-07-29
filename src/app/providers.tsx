"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fallback, http } from "viem";
import { WagmiProvider, createConfig } from "wagmi";
import { injected } from "@wagmi/core";
import { useEffect, useState, type ReactNode } from "react";
import { arcTestnet } from "@/lib/chains";
import { getSafeAppContext, safeAppConnector } from "@/lib/wallet/safe-app-connector";

const config = createConfig({
  chains: [arcTestnet],
  connectors: [
    safeAppConnector({ shimDisconnect: true }),
    injected({ shimDisconnect: true }),
  ],
  multiInjectedProviderDiscovery: true,
  transports: {
    [arcTestnet.id]: fallback(
      arcTestnet.rpcUrls.default.http.map((url) => http(url, { retryCount: 0, timeout: 8_000 })),
      { rank: false, retryCount: 0 },
    ),
  },
  ssr: true,
});

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  useEffect(() => {
    if (window.parent === window) return;
    // Safe validates a custom app immediately after embedding it. Establish
    // the SDK bridge on mount instead of waiting for a wallet-button action.
    void getSafeAppContext({}, 10_000).catch(() => {
      // The connector retries when the user opens the app if validation was
      // interrupted or the Safe parent was not ready yet.
    });
  }, []);
  return <WagmiProvider config={config}><QueryClientProvider client={queryClient}>{children}</QueryClientProvider></WagmiProvider>;
}
