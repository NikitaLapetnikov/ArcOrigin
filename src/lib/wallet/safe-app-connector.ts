import { SafeAppProvider } from "@safe-global/safe-apps-provider";
import SafeAppsSDK, {
  type Opts as SafeAppsOptions,
  type SafeInfo,
} from "@safe-global/safe-apps-sdk";
import {
  createConnector,
  ProviderNotFoundError,
  type Connector,
} from "@wagmi/core";
import { getAddress, withTimeout } from "viem";

type SafeAppConnectorParameters = SafeAppsOptions & {
  shimDisconnect?: boolean;
  getInfoTimeoutMs?: number;
};

type SafeAppContext = {
  sdk: SafeAppsSDK;
  safe: SafeInfo;
  provider: SafeAppProvider;
};

let safeAppContextPromise: Promise<SafeAppContext | undefined> | undefined;

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

class ArcOriginSafeAppProvider extends SafeAppProvider {
  private readonly safeAddress: string;

  constructor(
    safe: SafeInfo,
    private readonly arcOriginSdk: SafeAppsSDK,
  ) {
    super(safe, arcOriginSdk);
    this.safeAddress = safe.safeAddress.toLowerCase();
  }

  override async request(request: { method: string; params?: unknown[] }) {
    if (request.method !== "personal_sign") {
      return super.request(request);
    }

    const [message, address] = request.params ?? [];
    if (
      typeof message !== "string"
      || typeof address !== "string"
      || address.toLowerCase() !== this.safeAddress
    ) {
      throw new Error("Safe metadata message is invalid.");
    }

    await this.arcOriginSdk.eth.setSafeSettings([{ offChainSigning: true }]);
    const response = await this.arcOriginSdk.txs.signMessage(message) as
      | { signature: string }
      | { messageHash: string }
      | { safeTxHash: string };
    if ("signature" in response && response.signature !== "0x") {
      return response.signature;
    }
    if (!("messageHash" in response)) {
      throw new Error(
        "Safe off-chain signing is unavailable. Enable it in Safe settings and retry.",
      );
    }

    const expiresAt = Date.now() + 15 * 60 * 1_000;
    while (Date.now() < expiresAt) {
      const signature = await this.arcOriginSdk.safe.getOffChainSignature(
        response.messageHash,
      );
      if (signature && signature !== "0x") return signature;
      await wait(2_000);
    }
    throw new Error(
      "Safe metadata approval timed out. Confirm the message with the required Safe owners and retry.",
    );
  }
}

export async function getSafeAppContext(
  options: SafeAppsOptions = {},
  timeoutMs = 2_000,
) {
  const insideIframe = typeof window !== "undefined" && window.parent !== window;
  if (!insideIframe) return undefined;
  if (!safeAppContextPromise) {
    safeAppContextPromise = (async () => {
      const sdk = new SafeAppsSDK(options);
      const safe = await withTimeout(() => sdk.safe.getInfo(), {
        timeout: timeoutMs,
      });
      if (!safe) return undefined;
      return {
        sdk,
        safe,
        provider: new ArcOriginSafeAppProvider(safe, sdk),
      };
    })().catch((error) => {
      safeAppContextPromise = undefined;
      throw error;
    });
  }
  const context = await safeAppContextPromise;
  if (!context) safeAppContextPromise = undefined;
  return context;
}

/**
 * A deliberately narrow Safe Apps connector.
 *
 * Importing Wagmi's full connector barrel also bundles unrelated optional
 * Coinbase/x402 connectors. Keeping this adapter local gives ArcOrigin Safe
 * App support without adding those optional payment dependencies.
 */
export function safeAppConnector(parameters: SafeAppConnectorParameters = {}) {
  const {
    shimDisconnect = false,
    getInfoTimeoutMs = 2_000,
    ...safeAppsOptions
  } = parameters;

  type Provider = SafeAppProvider | undefined;
  type StorageItem = { "safe.disconnected": true };

  let provider: Provider;
  let disconnectListener: Connector["onDisconnect"] | undefined;

  return createConnector<Provider, Record<string, unknown>, StorageItem>((config) => ({
    id: "safe",
    name: "Safe",
    type: "safe",
    async connect({ withCapabilities } = {}) {
      const safeProvider = await this.getProvider() as Provider;
      if (!safeProvider) throw new ProviderNotFoundError();

      const accounts = await this.getAccounts();
      const chainId = await this.getChainId();
      if (!disconnectListener) {
        disconnectListener = this.onDisconnect.bind(this);
        safeProvider.on("disconnect", disconnectListener);
      }
      if (shimDisconnect) await config.storage?.removeItem("safe.disconnected");

      return {
        accounts: (withCapabilities
          ? accounts.map((address) => ({ address, capabilities: {} }))
          : accounts) as never,
        chainId,
      };
    },
    async disconnect() {
      const safeProvider = await this.getProvider() as Provider;
      if (!safeProvider) throw new ProviderNotFoundError();
      if (disconnectListener) {
        safeProvider.removeListener("disconnect", disconnectListener);
        disconnectListener = undefined;
      }
      if (shimDisconnect) {
        await config.storage?.setItem("safe.disconnected", true);
      }
    },
    async getAccounts() {
      const safeProvider = await this.getProvider() as Provider;
      if (!safeProvider) throw new ProviderNotFoundError();
      const accounts = await safeProvider.request({ method: "eth_accounts" });
      return accounts.map(getAddress);
    },
    async getProvider() {
      const insideIframe = typeof window !== "undefined" && window.parent !== window;
      if (!insideIframe) return undefined;
      if (provider) return provider;

      const context = await getSafeAppContext(safeAppsOptions, getInfoTimeoutMs);
      provider = context?.provider;
      return provider;
    },
    async getChainId() {
      const safeProvider = await this.getProvider() as Provider;
      if (!safeProvider) throw new ProviderNotFoundError();
      return Number(safeProvider.chainId);
    },
    async isAuthorized() {
      if (
        shimDisconnect
        && await config.storage?.getItem("safe.disconnected")
      ) return false;
      try {
        return (await this.getAccounts()).length > 0;
      } catch {
        return false;
      }
    },
    onAccountsChanged() {
      // A Safe App changes account by reloading in a different Safe context.
    },
    onChainChanged() {
      // A Safe contract wallet exists on one chain inside the Safe App frame.
    },
    onDisconnect() {
      config.emitter.emit("disconnect");
    },
  }));
}
