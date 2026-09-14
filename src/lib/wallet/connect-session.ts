import { connect, ConnectorAlreadyConnectedError, type Config, type Connector } from "@wagmi/core";

// A wallet approval is a user interaction, not a ten-second network request.
// Share the pending operation between desktop/mobile controls; never issue a
// second permissions request while the first wallet popup is still open.
const pendingConnections = new WeakMap<Config, Promise<void>>();

export function connectWalletSession(config: Config, connector: Connector): Promise<void> {
  const pending = pendingConnections.get(config);
  if (pending) return pending;
  const operation = (async () => {
    try {
      await connect(config, { connector });
    } catch (error) {
      if (!(error instanceof ConnectorAlreadyConnectedError)) throw error;
      if (config.state.status === "connected"
        && config.state.connections.get(connector.uid)?.accounts.length) return;

      // A stale current connector makes connect() reject before asking Rabby.
      // reconnect() can be a no-op while hydration is already reconnecting,
      // leaving the UI in an endless connect -> restore -> connect loop.
      // Remove only that stale app session, not the wallet's permissions.
      connector.emitter.emit("disconnect");
      config.setState((state) => {
        if (state.current !== connector.uid) return state;
        const connections = new Map(state.connections);
        connections.delete(connector.uid);
        return { ...state, connections, current: null, status: "disconnected" };
      });
      await connect(config, { connector });
    }
  })();
  pendingConnections.set(config, operation);
  void operation.finally(() => {
    if (pendingConnections.get(config) === operation) pendingConnections.delete(config);
  }).catch(() => {});
  return operation;
}

export function walletConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/already pending|resource.*unavailable|request.*pending|\b-32002\b/i.test(message)) {
    return "A connection request is already open. Open your wallet extension and approve or reject it, then try again.";
  }
  if (/user rejected|user denied|rejected.*request/i.test(message)) {
    return "Connection declined. You can choose your wallet and try again.";
  }
  return message.split("\n")[0] || "Could not connect this wallet. Unlock the extension and try again.";
}
