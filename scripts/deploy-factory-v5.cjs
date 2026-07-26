const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_TESTNET_CHAIN_ID = 5_042_002n;
const OFFICIAL_ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
const LAUNCH_FEE = 10n * 10n ** 6n;
const VIRTUAL_RESERVE = 2_500n * 10n ** 6n;
const GRADUATION_THRESHOLD = 10_000n * 10n ** 6n;
const deploymentPath = path.join(__dirname, "..", "deployment", "arc-testnet.json");
const outputPath = path.join(__dirname, "..", "deployment", "arcTestnet-v5.local.json");

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

async function main() {
  const current = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  if (fs.existsSync(outputPath) && process.env.DEPLOY_PREFLIGHT_ONLY !== "true") {
    throw new Error(`Refusing to overwrite existing candidate manifest at ${outputPath}.`);
  }
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is required.");
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, ARC_TESTNET_CHAIN_ID);
  assertEqual("deployer", deployer.address, current.deployer);
  assertEqual("USDC", current.contracts.usdc, OFFICIAL_ARC_TESTNET_USDC);

  const registry = await hre.ethers.getContractAt("ArcForgeCreatorRegistry", current.contracts.creatorRegistry);
  const vault = await hre.ethers.getContractAt("ArcForgeFeeVault", current.contracts.feeVault);
  assertEqual("registry owner", await registry.owner(), deployer.address);
  assertEqual("active registry factory", await registry.factory(), current.contracts.factory);
  assertEqual("vault owner", await vault.owner(), deployer.address);
  if ((await hre.ethers.provider.getBalance(deployer.address)) === 0n) {
    throw new Error("The deployer has no native Arc Testnet USDC for gas.");
  }
  console.log(`V5 preflight passed. DEX migration remains disabled until an audited Arc adapter exists.`);
  if (process.env.DEPLOY_PREFLIGHT_ONLY === "true") return;

  const Factory = await hre.ethers.getContractFactory("ArcForgeFactoryV5");
  const factory = await Factory.deploy(
    deployer.address,
    current.contracts.usdc,
    current.contracts.feeVault,
    current.contracts.creatorRegistry,
    LAUNCH_FEE,
    VIRTUAL_RESERVE,
    GRADUATION_THRESHOLD,
  );
  const transaction = factory.deploymentTransaction();
  console.log(`V5 factory deployment submitted: ${transaction.hash}`);
  const receipt = await transaction.wait();
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();

  assertEqual("launch fee", await factory.launchFee(), LAUNCH_FEE);
  assertEqual("virtual reserve", await factory.virtualUsdcReserve(), VIRTUAL_RESERVE);
  assertEqual("graduation target", await factory.graduationThreshold(), GRADUATION_THRESHOLD);
  assertEqual("migration adapter", await factory.dexMigrationAdapter(), hre.ethers.ZeroAddress);
  assertEqual("registry remains unchanged", await registry.factory(), current.contracts.factory);

  const candidate = {
    ...current,
    contracts: { ...current.contracts, factory: factoryAddress },
    legacyFactories: Array.from(new Set([current.contracts.factory, ...(current.legacyFactories ?? [])])),
    deployedAt: new Date().toISOString(),
    status: "V5_CANDIDATE_DEPLOYED",
    curveModel: {
      version: 5,
      virtualUsdcReserve: 2_500,
      graduationThreshold: 10_000,
      creatorFeeShareBps: 7_000,
      protocolFeeShareBps: 3_000,
      protectionBlocks: 3,
      maxProtectionHoldingBps: 500,
      maxProtectionPurchaseBps: 550,
      postGraduationVenue: "ARCFORGE_PERMANENT_AMM",
      dexMigrationReady: true,
      dexMigrationEnabled: false,
    },
    migration: {
      type: "FACTORY_V5",
      preservesFeeVault: true,
      preservesCreatorRegistry: true,
      previousFactory: current.contracts.factory,
      factoryDeploymentTx: transaction.hash,
      factoryDeploymentBlock: receipt.blockNumber,
      registryActivationTx: null,
    },
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`);
  console.log(`V5 candidate manifest written to ${outputPath}`);
  console.log(`V5 Factory: ${factoryAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
