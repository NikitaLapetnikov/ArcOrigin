const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_CHAIN_ID = 5_042_002;
const EXPECTED_LAUNCH_FEE = 10n * 10n ** 6n;
const EXPECTED_TRADING_FEE_BPS = 100n;

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withRpcRetry(label, operation, attempts = 5) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRateLimited = /too many requests|rate limit|\b429\b/i.test(message);
      if (!isRateLimited || attempt === attempts) {
        throw new Error(`${label} failed: ${message}`, { cause: error });
      }

      await wait(attempt * 1_500);
    }
  }

  throw new Error(`${label} failed after ${attempts} attempts.`);
}

async function main() {
  const manifestPath = path.join(__dirname, "..", "deployment", "arc-testnet.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const expectedOwner = manifest.governance?.timelock ?? manifest.deployer;
  const legacyFactories = manifest.legacyFactories ?? [];
  if (!Array.isArray(legacyFactories)) {
    throw new Error("legacyFactories must be an array when present.");
  }

  const network = await withRpcRetry("network lookup", () => hre.ethers.provider.getNetwork());
  assertEqual("chain ID", network.chainId, EXPECTED_CHAIN_ID);

  for (const [name, address] of Object.entries(manifest.contracts)) {
    if (!hre.ethers.isAddress(address)) throw new Error(`${name} is not a valid address.`);
    const code = await withRpcRetry(`${name} bytecode lookup`, () =>
      hre.ethers.provider.getCode(address),
    );
    if (code === "0x") throw new Error(`${name} has no bytecode at ${address}.`);
  }

  for (const [index, address] of legacyFactories.entries()) {
    if (!hre.ethers.isAddress(address)) {
      throw new Error(`legacy factory ${index + 1} is not a valid address.`);
    }
    const code = await withRpcRetry(`legacy factory ${index + 1} bytecode lookup`, () =>
      hre.ethers.provider.getCode(address),
    );
    if (code === "0x") throw new Error(`legacy factory has no bytecode at ${address}.`);
  }

  const vault = await hre.ethers.getContractAt("ArcForgeFeeVault", manifest.contracts.feeVault);
  const registry = await hre.ethers.getContractAt("ArcForgeCreatorRegistry", manifest.contracts.creatorRegistry);
  const factory = await hre.ethers.getContractAt(
    manifest.curveModel?.version >= 5 ? "ArcForgeFactoryV5" : "ArcForgeFactory",
    manifest.contracts.factory,
  );
  const values = [];
  for (const [label, read] of [
    ["vault owner", () => vault.owner()],
    ["fee recipient", () => vault.feeRecipient()],
    ["registry owner", () => registry.owner()],
    ["registry factory", () => registry.factory()],
    ["factory owner", () => factory.owner()],
    ["factory USDC", () => factory.usdc()],
    ["factory fee vault", () => factory.feeVault()],
    ["factory creator registry", () => factory.creatorRegistry()],
    ["launch fee", () => factory.launchFee()],
    ["buy fee", () => factory.buyFeeBps()],
    ["sell fee", () => factory.sellFeeBps()],
    ...(manifest.curveModel?.version >= 3
      ? [["graduation multiplier", () => factory.GRADUATION_RESERVE_MULTIPLIER()]]
      : []),
    ...(manifest.curveModel?.version >= 4
      ? [["creator fee share", () => factory.CREATOR_FEE_SHARE_BPS()]]
      : []),
  ]) {
    values.push(await withRpcRetry(label, read));
  }

  assertEqual("vault owner", values[0], expectedOwner);
  assertEqual("fee recipient", values[1], manifest.feeRecipient);
  assertEqual("registry owner", values[2], expectedOwner);
  assertEqual("registry factory", values[3], manifest.contracts.factory);
  assertEqual("factory owner", values[4], expectedOwner);
  assertEqual("factory USDC", values[5], manifest.contracts.usdc);
  assertEqual("factory fee vault", values[6], manifest.contracts.feeVault);
  assertEqual("factory creator registry", values[7], manifest.contracts.creatorRegistry);
  assertEqual("launch fee", values[8], EXPECTED_LAUNCH_FEE);
  assertEqual("buy fee", values[9], EXPECTED_TRADING_FEE_BPS);
  assertEqual("sell fee", values[10], EXPECTED_TRADING_FEE_BPS);
  if (manifest.curveModel?.version >= 3) {
    assertEqual("graduation multiplier", values[11], 4n);
  }
  if (manifest.curveModel?.version >= 4) {
    assertEqual("creator fee share", values[12], 7_000n);
  }

  for (const [index, address] of legacyFactories.entries()) {
    const legacyFactory = await hre.ethers.getContractAt("ArcForgeFactory", address);
    const prefix = `legacy factory ${index + 1}`;
    const legacyValues = [];
    for (const [label, read] of [
      ["owner", () => legacyFactory.owner()],
      ["USDC", () => legacyFactory.usdc()],
      ["fee vault", () => legacyFactory.feeVault()],
      ["creator registry", () => legacyFactory.creatorRegistry()],
      ["launch fee", () => legacyFactory.launchFee()],
      ["buy fee", () => legacyFactory.buyFeeBps()],
      ["sell fee", () => legacyFactory.sellFeeBps()],
    ]) {
      legacyValues.push(await withRpcRetry(`${prefix} ${label}`, read));
    }

    assertEqual(`${prefix} owner`, legacyValues[0], expectedOwner);
    assertEqual(`${prefix} USDC`, legacyValues[1], manifest.contracts.usdc);
    assertEqual(`${prefix} fee vault`, legacyValues[2], manifest.contracts.feeVault);
    assertEqual(`${prefix} creator registry`, legacyValues[3], manifest.contracts.creatorRegistry);
    if (legacyValues[4] < 0n) throw new Error(`${prefix} launch fee is invalid.`);
    assertEqual(`${prefix} buy fee`, legacyValues[5], EXPECTED_TRADING_FEE_BPS);
    assertEqual(`${prefix} sell fee`, legacyValues[6], EXPECTED_TRADING_FEE_BPS);
  }

  const blockNumber = await withRpcRetry("block number lookup", () =>
    hre.ethers.provider.getBlockNumber(),
  );
  console.log(`Verified ArcForge deployment at block ${blockNumber}.`);
  console.log(`Factory: ${manifest.contracts.factory}`);
  for (const address of legacyFactories) console.log(`Legacy Factory: ${address}`);
  console.log(`FeeVault: ${manifest.contracts.feeVault}`);
  console.log(`CreatorRegistry: ${manifest.contracts.creatorRegistry}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
