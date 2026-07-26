const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ownableAbi = ["function owner() view returns (address)"];
const vaultAbi = [
  ...ownableAbi,
  "function feeRecipient() view returns (address)",
];
const registryAbi = [
  ...ownableAbi,
  "function factory() view returns (address)",
];
const factoryAbi = [
  ...ownableAbi,
  "function launchFee() view returns (uint256)",
  "function buyFeeBps() view returns (uint16)",
  "function sellFeeBps() view returns (uint16)",
  "function virtualUsdcReserve() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function protectionBlocks() view returns (uint16)",
  "function maxProtectionHoldingBps() view returns (uint16)",
  "function maxProtectionPurchaseBps() view returns (uint16)",
  "function dexMigrationAdapter() view returns (address)",
  "function liquidityLocker() view returns (address)",
];

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withRpcRetry(label, operation, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/too many requests|rate limit|request limit|HTTP 429|\\b429\\b/i.test(message) || attempt === attempts) {
        throw new Error(`${label} failed: ${message}`, { cause: error });
      }
      await wait(attempt * 1_500);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts.`);
}

async function main() {
  const deploymentPath = path.join(__dirname, "..", "deployment", "arc-testnet.json");
  const manifest = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const factory = new hre.ethers.Contract(manifest.contracts.factory, factoryAbi, hre.ethers.provider);
  const registry = new hre.ethers.Contract(manifest.contracts.creatorRegistry, registryAbi, hre.ethers.provider);
  const vault = new hre.ethers.Contract(manifest.contracts.feeVault, vaultAbi, hre.ethers.provider);
  const reads = {};
  for (const [label, read] of [
    ["factoryOwner", () => factory.owner()],
    ["registryOwner", () => registry.owner()],
    ["registryFactory", () => registry.factory()],
    ["vaultOwner", () => vault.owner()],
    ["feeRecipient", () => vault.feeRecipient()],
    ["launchFee", () => factory.launchFee()],
    ["buyFeeBps", () => factory.buyFeeBps()],
    ["sellFeeBps", () => factory.sellFeeBps()],
    ["virtualUsdcReserve", () => factory.virtualUsdcReserve()],
    ["graduationThreshold", () => factory.graduationThreshold()],
    ["protectionBlocks", () => factory.protectionBlocks()],
    ["maxProtectionHoldingBps", () => factory.maxProtectionHoldingBps()],
    ["maxProtectionPurchaseBps", () => factory.maxProtectionPurchaseBps()],
    ["dexMigrationAdapter", () => factory.dexMigrationAdapter()],
    ["liquidityLocker", () => factory.liquidityLocker()],
  ]) {
    reads[label] = await withRpcRetry(label, read);
    await wait(150);
  }
  const {
    factoryOwner,
    registryOwner,
    registryFactory,
    vaultOwner,
    feeRecipient,
    launchFee,
    buyFeeBps,
    sellFeeBps,
    virtualUsdcReserve,
    graduationThreshold,
    protectionBlocks,
    maxProtectionHoldingBps,
    maxProtectionPurchaseBps,
    dexMigrationAdapter,
    liquidityLocker,
  } = reads;
  const adminAddresses = new Set([factoryOwner, registryOwner, vaultOwner, feeRecipient].map((address) => address.toLowerCase()));
  const report = {
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    blockNumber: await withRpcRetry("blockNumber", () => hre.ethers.provider.getBlockNumber()),
    contracts: manifest.contracts,
    administration: {
      factoryOwner,
      registryOwner,
      vaultOwner,
      feeRecipient,
      uniquePrivilegedAddresses: adminAddresses.size,
      governanceConfigured: Boolean(manifest.governance?.timelock),
    },
    activeConfiguration: {
      registryFactory,
      launchFeeBaseUnits: launchFee.toString(),
      buyFeeBps: Number(buyFeeBps),
      sellFeeBps: Number(sellFeeBps),
      virtualUsdcReserveBaseUnits: virtualUsdcReserve.toString(),
      graduationThresholdBaseUnits: graduationThreshold.toString(),
      protectionBlocks: Number(protectionBlocks),
      maxProtectionHoldingBps: Number(maxProtectionHoldingBps),
      maxProtectionPurchaseBps: Number(maxProtectionPurchaseBps),
      dexMigrationAdapter,
      liquidityLocker,
    },
    findings: [
      ...(adminAddresses.size === 1 && !manifest.governance?.timelock
        ? ["HIGH: one address controls all owner roles and immediate FeeVault withdrawal."]
        : []),
      ...(feeRecipient.toLowerCase() === manifest.deployer.toLowerCase()
        ? ["HIGH: the deployment EOA remains the FeeVault recipient."]
        : []),
      ...(dexMigrationAdapter !== hre.ethers.ZeroAddress
        ? ["CRITICAL REVIEW REQUIRED: DEX migration is enabled for future curves."]
        : ["INFO: DEX migration remains disabled for future curves."]),
      "INFO: owner changes affect future launches and registry routing, not immutable settings of existing curves.",
      "INFO: existing curve reserves have no owner withdrawal path.",
    ],
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
