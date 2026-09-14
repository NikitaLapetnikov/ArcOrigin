"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fallback, http } from "viem";
import { WagmiProvider, createConfig, useConnectors } from "wagmi";
import { injected } from "@wagmi/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LiveIndexerBridge } from "@/components/live-indexer-bridge";
import { arcMainnet } from "@/lib/chains";
import { ARC_RPC_RELAY_URL } from "@/lib/onchain/browser-arc-rpc";
import { getSafeAppContext, safeAppConnector } from "@/lib/wallet/safe-app-connector";
import { restoreWalletSession } from "@/lib/wallet/connect-session";

function connectors() {
  return [
    safeAppConnector({ shimDisconnect: true }),
    injected({ shimDisconnect: true }),
  ];
}

function rpcTransport(urls: readonly string[]) {
  return fallback(
    urls.map((url) => http(url, { retryCount: 0, timeout: 8_000 })),
    {
      rank: {
        interval: 15_000,
        sampleCount: 6,
        timeout: 1_200,
        weights: { latency: 0.35, stability: 0.65 },
        ping: ({ transport }) => transport.request({ method: "eth_blockNumber" }),
      },
      retryCount: 0,
    },
  );
}

const config = createConfig({
  chains: [arcMainnet],
  connectors: connectors(),
  multiInjectedProviderDiscovery: true,
  transports: { [arcMainnet.id]: rpcTransport([ARC_RPC_RELAY_URL, ...arcMainnet.rpcUrls.default.http]) },
  ssr: true,
});

function WalletSessionRestore() {
  const available = useConnectors();
  const started = useRef(false);
  useEffect(() => {
    let cancelled = false;
    // Hydrate completes its local-storage microtasks before this timer. The
    // effect also reruns if EIP-6963 discovers the saved extension later.
    const timer = window.setTimeout(() => {
      void (async () => {
        const recentId = await config.storage?.getItem("recentConnectorId");
        if (cancelled || started.current) return;
        const insideSafe = window.parent !== window;
        const connector = available.find((item) => insideSafe
          ? item.id === "safe"
          : item.id === recentId && item.id !== "safe");
        if (!connector) return;
        started.current = true;
        await restoreWalletSession(config, connector);
      })().catch(() => {
        // Manual connection remains available if the saved wallet cannot restore.
      });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [available]);
  return null;
}

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
  return <WagmiProvider config={config} reconnectOnMount={false}><QueryClientProvider client={queryClient}><WalletSessionRestore /><LiveIndexerBridge />{children}</QueryClientProvider></WagmiProvider>;
}
