const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_MAINNET_CHAIN_ID = 5_042n;
const manifestPath = process.env.MAINNET_DEPLOYMENT_MANIFEST
  ? path.resolve(process.env.MAINNET_DEPLOYMENT_MANIFEST)
  : path.join(__dirname, "..", "deployment", "arc-mainnet.local.json");

function requiredAddress(name) {
  const value = process.env[name]?.trim();
  if (!value || !hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero address.`);
  }
  return hre.ethers.getAddress(value);
}

function requiredAddressList(name) {
  const values = (process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => hre.ethers.getAddress(value));
  if (values.length !== 3 || new Set(values.map((value) => value.toLowerCase())).size !== 3) {
    throw new Error(`${name} must contain exactly three unique addresses.`);
  }
  return values;
}

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

async function main() {
  if (!process.env.ARC_MAINNET_RPC_URL?.trim()) {
    throw new Error("ARC_MAINNET_RPC_URL must be explicitly configured.");
  }
  if (!fs.existsSync(manifestPath)) throw new Error(`Manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const mode = (process.env.MAINNET_DEPLOYMENT_MODE || "candidate").toLowerCase();
  if (!new Set(["candidate", "active"]).has(mode)) {
    throw new Error("MAINNET_DEPLOYMENT_MODE must be candidate or active.");
  }
  const governanceSafe = requiredAddress("MAINNET_GOVERNANCE_SAFE");
  const expectedSafeOwners = requiredAddressList("MAINNET_GOVERNANCE_SAFE_OWNERS");
  const retiredFactory = requiredAddress("MAINNET_RETIRED_FACTORY_ADDRESS");
  const protocolFeeRecipient = requiredAddress("MAINNET_PROTOCOL_FEE_RECIPIENT");
  const factoryAddress = hre.ethers.getAddress(manifest.contracts.factory);
  const lockerAddress = hre.ethers.getAddress(manifest.contracts.liquidityLocker);
  const feeVault = hre.ethers.getAddress(manifest.contracts.feeVault);
  const creatorRegistry = hre.ethers.getAddress(manifest.contracts.creatorRegistry);
  const provider = hre.ethers.provider;
  const network = await provider.getNetwork();
  assertEqual("chain ID", network.chainId, ARC_MAINNET_CHAIN_ID);
  assertEqual("manifest chain ID", manifest.chainId, ARC_MAINNET_CHAIN_ID);

  for (const [label, address] of [
    ["Factory", factoryAddress],
    ["LiquidityLocker", lockerAddress],
    ["Governance Safe", governanceSafe],
    ["FeeVault", feeVault],
    ["CreatorRegistry", creatorRegistry],
    ["retired Factory", retiredFactory],
  ]) {
    if ((await provider.getCode(address)) === "0x") {
      throw new Error(`${label} has no deployed bytecode.`);
    }
  }

  const safe = new hre.ethers.Contract(
    governanceSafe,
    ["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)"],
    provider,
  );
  const factory = await hre.ethers.getContractAt("ArcForgeFactory", factoryAddress);
  const locker = await hre.ethers.getContractAt(
    "ArcOriginUniswapV3LiquidityLocker",
    lockerAddress,
  );
  const vault = new hre.ethers.Contract(
    feeVault,
    [
      "function owner() view returns (address)",
      "function feeRecipient() view returns (address)",
      "function isRegistrar(address) view returns (bool)",
      "function isCollector(address) view returns (bool)",
    ],
    provider,
  );
  const registry = new hre.ethers.Contract(
    creatorRegistry,
    ["function owner() view returns (address)", "function factory() view returns (address)"],
    provider,
  );
  const retired = new hre.ethers.Contract(
    retiredFactory,
    ["function owner() view returns (address)", "function paused() view returns (bool)"],
    provider,
  );

  const [owners, threshold] = await Promise.all([safe.getOwners(), safe.getThreshold()]);
  if (
    threshold !== 2n ||
    owners.length !== 3 ||
    expectedSafeOwners.some(
      (owner) => !owners.some((actual) => actual.toLowerCase() === owner.toLowerCase()),
    )
  ) throw new Error("Governance Safe owner set or threshold mismatch.");

  assertEqual("Factory owner", await factory.owner(), governanceSafe);
  assertEqual("Factory emergency guardian", await factory.emergencyGuardian(), manifest.governance.emergencyGuardian);
  assertEqual("Factory USDC", await factory.usdc(), manifest.contracts.usdc);
  assertEqual("Factory FeeVault", await factory.feeVault(), feeVault);
  assertEqual("Factory CreatorRegistry", await factory.creatorRegistry(), creatorRegistry);
  assertEqual("Factory Uniswap Factory", await factory.uniswapV3Factory(), manifest.contracts.uniswapV3Factory);
  assertEqual("Factory PositionManager", await factory.positionManager(), manifest.contracts.uniswapV3PositionManager);
  assertEqual("Factory Locker", await factory.liquidityLocker(), lockerAddress);
  assertEqual("Factory launch fee", await factory.launchFee(), 10n * 10n ** 6n);
  assertEqual("Locker Factory", await locker.factory(), factoryAddress);
  assertEqual("Locker PositionManager", await locker.positionManager(), manifest.contracts.uniswapV3PositionManager);
  assertEqual("Locker protocol recipient", await locker.protocolFeeRecipient(), feeVault);
  assertEqual("FeeVault owner", await vault.owner(), governanceSafe);
  assertEqual("CreatorRegistry owner", await registry.owner(), governanceSafe);
  assertEqual("retired Factory owner", await retired.owner(), governanceSafe);

  const expectedActive = mode === "active";
  assertEqual("Factory paused state", await factory.paused(), !expectedActive);
  assertEqual("new Factory registrar ACL", await vault.isRegistrar(factoryAddress), expectedActive);
  assertEqual("new Factory collector ACL", await vault.isCollector(factoryAddress), expectedActive);
  if (expectedActive) {
    assertEqual("retired Factory paused state", await retired.paused(), true);
    assertEqual("retired Factory registrar ACL", await vault.isRegistrar(retiredFactory), false);
    assertEqual("retired Factory collector ACL", await vault.isCollector(retiredFactory), false);
    assertEqual("CreatorRegistry active Factory", await registry.factory(), factoryAddress);
    assertEqual("protocol fee recipient", await vault.feeRecipient(), protocolFeeRecipient);
  } else {
    assertEqual("Candidate launch count", await factory.getLaunchedTokenCount(), 0);
    assertEqual("CreatorRegistry remains on retired Factory", await registry.factory(), retiredFactory);
  }

  console.log(JSON.stringify({
    verified: true,
    checkedAt: new Date().toISOString(),
    mode,
    chainId: Number(network.chainId),
    blockNumber: await provider.getBlockNumber(),
    factory: factoryAddress,
    liquidityLocker: lockerAddress,
    governanceSafe,
    safeThreshold: Number(threshold),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
