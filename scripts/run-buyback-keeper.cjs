const {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  getAddress,
  http,
  isAddress,
} = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const ARC_MAINNET_CHAIN_ID = 5_042;
const PAGE_SIZE = 100n;
const DEFAULT_RPC_MINIMUM_SPACING_MS = 500;
const DEFAULT_RPC_ATTEMPTS = 6;
const arcMainnet = defineChain({
  id: ARC_MAINNET_CHAIN_ID,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://invalid.invalid"] } },
});

const factoryAbi = [
  { type: "function", name: "liquidityLocker", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getLaunchedTokenCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "getLaunchedTokens",
    stateMutability: "view",
    inputs: [{ name: "offset", type: "uint256" }, { name: "limit", type: "uint256" }],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "getTokenInfo",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "token", type: "address" },
        { name: "pool", type: "address" },
        { name: "creator", type: "address" },
        { name: "positionId", type: "uint256" },
        { name: "launchedAt", type: "uint64" },
        { name: "tokenIsToken0", type: "bool" },
        { name: "crossed", type: "bool" },
        { name: "automaticBuyback", type: "bool" },
        { name: "metadataURI", type: "string" },
      ],
    }],
  },
];
const lockerAbi = [
  { type: "error", name: "BuybackNotReady", inputs: [] },
  { type: "error", name: "UnsafePrice", inputs: [] },
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "collectAndExecuteBuyback",
    stateMutability: "nonpayable",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [
      { name: "quoteSpent", type: "uint256" },
      { name: "keeperReward", type: "uint256" },
      { name: "tokensBurned", type: "uint256" },
    ],
  },
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured.`);
  return value;
}

function requiredAddress(name) {
  const value = required(name);
  if (!isAddress(value) || value === "0x0000000000000000000000000000000000000000") {
    throw new Error(`${name} must be a non-zero address.`);
  }
  return getAddress(value);
}

function expectedSkip(error) {
  const message = `${error?.shortMessage ?? ""} ${error?.details ?? ""} ${error?.message ?? ""}`;
  return /BuybackNotReady|UnsafePrice|\bOLD\b/i.test(message);
}

function transientRpcFailure(error) {
  const message = `${error?.shortMessage ?? ""} ${error?.details ?? ""} ${error?.message ?? ""}`;
  return /Request exceeds defined limit|temporarily out of capacity|all upstream|Too Many Requests|rate limit|timeout|timed out|fetch failed|network error|\b429\b|\b50[234]\b|\b-32005\b/i.test(message);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let nextRpcRequestAt = 0;

function rpcMinimumSpacingMs() {
  const configured = Number.parseInt(process.env.BUYBACK_KEEPER_RPC_MINIMUM_SPACING_MS || "", 10);
  return Number.isFinite(configured) && configured >= 0
    ? configured
    : DEFAULT_RPC_MINIMUM_SPACING_MS;
}

async function waitForRpcSlot() {
  const now = Date.now();
  const delay = Math.max(0, nextRpcRequestAt - now);
  nextRpcRequestAt = Math.max(now, nextRpcRequestAt) + rpcMinimumSpacingMs();
  if (delay > 0) await wait(delay);
}

async function withRpcRetry(operation, attempts = DEFAULT_RPC_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await waitForRpcSlot();
      return await operation();
    } catch (error) {
      lastError = error;
      if (!transientRpcFailure(error) || attempt === attempts) throw error;
      await wait(Math.min(12_000, attempt * attempt * 750));
    }
  }
  throw lastError;
}

async function launchedTokens(client, factoryAddress) {
  const count = await withRpcRetry(() => client.readContract({
    address: factoryAddress,
    abi: factoryAbi,
    functionName: "getLaunchedTokenCount",
  }));
  const tokens = [];
  for (let offset = 0n; offset < count; offset += PAGE_SIZE) {
    tokens.push(...await withRpcRetry(() => client.readContract({
      address: factoryAddress,
      abi: factoryAbi,
      functionName: "getLaunchedTokens",
      args: [offset, PAGE_SIZE],
    })));
  }
  return tokens;
}

async function main() {
  const rpcUrl = required("BUYBACK_KEEPER_RPC_URL");
  const rpcFallbackUrls = (process.env.BUYBACK_KEEPER_RPC_FALLBACK_URLS || "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const rpcUrls = [...new Set([rpcUrl, ...rpcFallbackUrls])];
  const privateKey = required("BUYBACK_KEEPER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("BUYBACK_KEEPER_PRIVATE_KEY must be a 32-byte hex private key.");
  }
  const factoryAddress = requiredAddress("BUYBACK_KEEPER_FACTORY_ADDRESS");
  const transport = fallback(
    rpcUrls.map((url) => http(url, { timeout: 12_000, retryCount: 0 })),
    { rank: false, retryCount: 0 },
  );
  const publicClient = createPublicClient({ chain: arcMainnet, transport });
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account, chain: arcMainnet, transport });
  const chainId = await withRpcRetry(() => publicClient.getChainId());
  if (chainId !== ARC_MAINNET_CHAIN_ID) {
    throw new Error(`Keeper RPC chain mismatch: expected ${ARC_MAINNET_CHAIN_ID}, received ${chainId}.`);
  }
  if (!await withRpcRetry(() => publicClient.getCode({ address: factoryAddress }))) {
    throw new Error("Configured Factory has no bytecode.");
  }

  const lockerAddress = getAddress(await withRpcRetry(() => publicClient.readContract({
    address: factoryAddress,
    abi: factoryAbi,
    functionName: "liquidityLocker",
  })));
  if (!await withRpcRetry(() => publicClient.getCode({ address: lockerAddress }))) {
    throw new Error("Factory Locker has no bytecode.");
  }
  const lockerFactory = await withRpcRetry(() => publicClient.readContract({
    address: lockerAddress,
    abi: lockerAbi,
    functionName: "factory",
  }));
  if (getAddress(lockerFactory) !== factoryAddress) {
    throw new Error("Locker does not belong to the configured Factory.");
  }

  let enabled = 0;
  let executed = 0;
  let failures = 0;
  for (const token of await launchedTokens(publicClient, factoryAddress)) {
    const info = await withRpcRetry(() => publicClient.readContract({
      address: factoryAddress,
      abi: factoryAbi,
      functionName: "getTokenInfo",
      args: [token],
    }));
    if (!info.automaticBuyback) continue;
    enabled += 1;
    try {
      const simulation = await withRpcRetry(() => publicClient.simulateContract({
        account,
        address: lockerAddress,
        abi: lockerAbi,
        functionName: "collectAndExecuteBuyback",
        args: [info.positionId],
      }));
      const estimatedGas = await withRpcRetry(() => publicClient.estimateContractGas({
        account,
        address: lockerAddress,
        abi: lockerAbi,
        functionName: "collectAndExecuteBuyback",
        args: [info.positionId],
      }));
      const transactionHash = await withRpcRetry(() => walletClient.writeContract({
        ...simulation.request,
        gas: estimatedGas * 120n / 100n,
      }));
      const receipt = await withRpcRetry(() => publicClient.waitForTransactionReceipt({ hash: transactionHash }));
      if (receipt.status !== "success") throw new Error("Buyback transaction failed.");
      executed += 1;
      console.log(JSON.stringify({
        event: "buyback_executed",
        token,
        positionId: info.positionId.toString(),
        quoteSpent: simulation.result[0].toString(),
        keeperReward: simulation.result[1].toString(),
        tokensBurned: simulation.result[2].toString(),
        transactionHash,
      }));
    } catch (error) {
      if (expectedSkip(error)) continue;
      failures += 1;
      console.error(JSON.stringify({
        event: "buyback_execution_error",
        token,
        positionId: info.positionId.toString(),
        error: error?.shortMessage ?? error?.message ?? String(error),
      }));
    }
  }
  console.log(JSON.stringify({
    event: "buyback_keeper_complete",
    factory: factoryAddress,
    keeper: account.address,
    rpcEndpoints: rpcUrls.length,
    enabledPositions: enabled,
    executed,
    failures,
  }));
  if (failures !== 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = { transientRpcFailure, withRpcRetry };
