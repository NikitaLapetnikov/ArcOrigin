"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");
const { createConfig, createConnector, getAccount, http } = require("@wagmi/core");
const { mainnet } = require("viem/chains");
const source = ts.transpileModule(fs.readFileSync("src/lib/wallet/connect-session.ts", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = { exports: {} };
Function("require", "module", "exports", source)(require, loaded, loaded.exports);
const { connectWalletSession, walletConnectionError } = loaded.exports;
const address = "0x1111111111111111111111111111111111111111";

function fixture(connectOperation) {
  let prompts = 0;
  const config = createConfig({
    chains: [mainnet], storage: null, ssr: true, multiInjectedProviderDiscovery: false,
    transports: { [mainnet.id]: http("https://unused.invalid") },
    connectors: [createConnector(() => ({
      id: "rabby", name: "Rabby Wallet", type: "injected",
      async connect() {
        prompts += 1;
        if (connectOperation) await connectOperation();
        return { accounts: [address], chainId: 1 };
      },
      async disconnect() { throw new Error("Must not revoke wallet permissions"); },
      async getAccounts() { return [address]; },
      async getChainId() { return 1; },
      async getProvider() { return {}; },
      async isAuthorized() { return true; },
      onAccountsChanged() {}, onChainChanged() {}, onDisconnect() {},
    }))],
  });
  return { config, connector: config.connectors[0], prompts: () => prompts };
}

test("stale current connector recovers through the normal connection pipeline", async () => {
  const { config, connector, prompts } = fixture();
  config.setState((state) => ({ ...state, current: connector.uid, status: "connecting" }));
  await connectWalletSession(config, connector);
  assert.equal(getAccount(config).address, address);
  assert.equal(getAccount(config).isConnected, true);
  assert.equal(prompts(), 1);
  assert.equal(connector.emitter.listenerCount("change"), 1);
  assert.equal(connector.emitter.listenerCount("disconnect"), 1);
});

test("existing connected session does not request permissions again", async () => {
  const { config, connector, prompts } = fixture();
  await connectWalletSession(config, connector);
  await connectWalletSession(config, connector);
  assert.equal(prompts(), 1);
});

test("slow confirmation is preserved and duplicate controls share one request", async () => {
  let approve;
  const confirmation = new Promise((resolve) => { approve = resolve; });
  const { config, connector, prompts } = fixture(() => confirmation);
  const first = connectWalletSession(config, connector);
  const second = connectWalletSession(config, connector);
  assert.equal(first, second);
  assert.equal(prompts(), 1);
  assert.equal(getAccount(config).status, "connecting");
  approve();
  await first;
  assert.equal(getAccount(config).isConnected, true);
});

test("rejection releases the request so the user can retry", async () => {
  let reject = true;
  const { config, connector, prompts } = fixture(() => {
    if (reject) throw new Error("User rejected the request");
  });
  await assert.rejects(connectWalletSession(config, connector), /User rejected/);
  reject = false;
  await connectWalletSession(config, connector);
  assert.equal(prompts(), 2);
  assert.equal(getAccount(config).isConnected, true);
});

test("stale session recovery does not duplicate event listeners", async () => {
  const { config, connector } = fixture();
  await connectWalletSession(config, connector);
  config.setState((state) => ({ ...state, status: "connecting" }));
  await connectWalletSession(config, connector);
  assert.equal(connector.emitter.listenerCount("change"), 1);
  assert.equal(connector.emitter.listenerCount("disconnect"), 1);
  assert.equal(getAccount(config).isConnected, true);
});

test("pending and rejected requests have actionable messages", () => {
  assert.match(walletConnectionError(new Error("Request already pending")), /Open your wallet/);
  assert.match(walletConnectionError(new Error("User rejected the request")), /Connection declined/);
});
