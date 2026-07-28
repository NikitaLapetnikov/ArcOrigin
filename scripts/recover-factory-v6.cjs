const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_TESTNET_CHAIN_ID = 5_042_002n;
const OFFICIAL_ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
const LAUNCH_FEE = 10n * 10n ** 6n;
const VIRTUAL_RESERVE = 2_500n * 10n ** 6n;
const GRADUATION_THRESHOLD = 10_000n * 10n ** 6n;
const deploymentPath = path.join(__dirname, "..", "deployment", "arc-testnet.json");
const outputPath = path.join(__dirname, "..", "deployment", "arcTestnet-v6.local.json");

function requiredAddress(name) {
  const value = process.env[name];
  if (!value || !hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
    throw new Error(`${name} must be an explicitly configured non-zero address.`);
  }
  return hre.ethers.getAddress(value);
}

function requiredHash(name) {
  const value = process.env[name];
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a transaction hash.`);
  }
  return value;
}

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getReceipt(hash) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const receipt = await hre.ethers.provider.getTransactionReceipt(hash);
      if (receipt) return receipt;
    } catch (error) {
      lastError = error;
    }
    await wait(500);
  }
  throw lastError ?? new Error(`Receipt not found for ${hash}.`);
}

async function verifyDeployment(label, address, hash) {
  const receipt = await getReceipt(hash);
  if (receipt.status !== 1) throw new Error(`${label} deployment reverted.`);
  assertEqual(`${label} receipt address`, receipt.contractAddress, address);
  if (await hre.ethers.provider.getCode(address) === "0x") {
    throw new Error(`${label} has no deployed bytecode.`);
  }
  return receipt;
}

async function sendIfNeeded(needed, transactionFactory, label, hashes) {
  if (!needed) return;
  const transaction = await transactionFactory();
  console.log(`${label}: ${transaction.hash}`);
  const receipt = await getReceipt(transaction.hash);
  if (receipt.status !== 1) throw new Error(`${label} reverted.`);
  hashes.push(transaction.hash);
}

async function main() {
  if (fs.existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite existing candidate manifest at ${outputPath}.`);
  }
  const current = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const feeVaultAddress = requiredAddress("V6_FEE_VAULT_ADDRESS");
  const creatorRegistryAddress = requiredAddress("V6_CREATOR_REGISTRY_ADDRESS");
  const curveDeployerAddress = requiredAddress("V6_CURVE_DEPLOYER_ADDRESS");
  const factoryAddress = requiredAddress("V6_FACTORY_ADDRESS");
  const treasurySafe = requiredAddress("TREASURY_SAFE");
  const emergencyGuardian = requiredAddress("EMERGENCY_GUARDIAN");
  const deploymentHashes = {
    feeVault: requiredHash("V6_FEE_VAULT_DEPLOYMENT_TX"),
    creatorRegistry: requiredHash("V6_CREATOR_REGISTRY_DEPLOYMENT_TX"),
    curveDeployer: requiredHash("V6_CURVE_DEPLOYER_DEPLOYMENT_TX"),
    factory: requiredHash("V6_FACTORY_DEPLOYMENT_TX"),
  };
  const knownConfigurationHashes = (process.env.V6_CONFIGURATION_TXS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const hash of knownConfigurationHashes) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`Invalid configuration transaction hash: ${hash}`);
    const receipt = await getReceipt(hash);
    if (receipt.status !== 1) throw new Error(`Configuration transaction reverted: ${hash}`);
  }

  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, ARC_TESTNET_CHAIN_ID);
  assertEqual("deployer", deployer.address, current.deployer);
  const feeVaultReceipt = await verifyDeployment(
    "V6 FeeVault",
    feeVaultAddress,
    deploymentHashes.feeVault,
  );
  const creatorRegistryReceipt = await verifyDeployment(
    "V6 CreatorRegistry",
    creatorRegistryAddress,
    deploymentHashes.creatorRegistry,
  );
  const curveDeployerReceipt = await verifyDeployment(
    "V6 CurveDeployer",
    curveDeployerAddress,
    deploymentHashes.curveDeployer,
  );
  const factoryReceipt = await verifyDeployment(
    "V6 Factory",
    factoryAddress,
    deploymentHashes.factory,
  );

  const vault = await hre.ethers.getContractAt("ArcForgeFeeVaultV6", feeVaultAddress, deployer);
  const registry = await hre.ethers.getContractAt("ArcForgeCreatorRegistryV6", creatorRegistryAddress, deployer);
  const curveDeployer = await hre.ethers.getContractAt("ArcForgeCurveDeployerV6", curveDeployerAddress, deployer);
  const factory = await hre.ethers.getContractAt("ArcForgeFactoryV6", factoryAddress, deployer);
  assertEqual("factory owner", await factory.owner(), deployer.address);
  assertEqual("factory guardian", await factory.emergencyGuardian(), emergencyGuardian);
  assertEqual("factory USDC", await factory.usdc(), OFFICIAL_ARC_TESTNET_USDC);
  assertEqual("launch fee", await factory.launchFee(), LAUNCH_FEE);
  assertEqual("virtual reserve", await factory.virtualUsdcReserve(), VIRTUAL_RESERVE);
  assertEqual("graduation target", await factory.graduationThreshold(), GRADUATION_THRESHOLD);
  assertEqual("migration adapter", await factory.dexMigrationAdapter(), hre.ethers.ZeroAddress);
  assertEqual("migration paused", await factory.migrationPaused(), true);
  assertEqual("vault recipient", await vault.feeRecipient(), treasurySafe);

  const configurationHashes = [...knownConfigurationHashes];
  await sendIfNeeded(
    !await vault.isRegistrar(factoryAddress),
    () => vault.setRegistrar(factoryAddress, true),
    "Authorize Factory as collector registrar",
    configurationHashes,
  );
  await sendIfNeeded(
    !await vault.isCollector(factoryAddress),
    () => vault.setCollector(factoryAddress, true),
    "Authorize Factory fee collection",
    configurationHashes,
  );
  const configuredRegistryFactory = await registry.factory();
  if (
    configuredRegistryFactory !== hre.ethers.ZeroAddress
    && configuredRegistryFactory.toLowerCase() !== factoryAddress.toLowerCase()
  ) {
    throw new Error(`V6 Registry is already bound to unexpected Factory ${configuredRegistryFactory}.`);
  }
  await sendIfNeeded(
    configuredRegistryFactory === hre.ethers.ZeroAddress,
    () => registry.setFactory(factoryAddress),
    "Select V6 Factory in isolated V6 Registry",
    configurationHashes,
  );
  const configuredCurveFactory = await curveDeployer.factory();
  if (configuredCurveFactory.toLowerCase() !== factoryAddress.toLowerCase()) {
    throw new Error(`CurveDeployer is not irreversibly bound to V6 Factory: ${configuredCurveFactory}.`);
  }

  assertEqual("vault registrar", await vault.isRegistrar(factoryAddress), true);
  assertEqual("vault collector", await vault.isCollector(factoryAddress), true);
  assertEqual("registry factory", await registry.factory(), factoryAddress);
  assertEqual("curve deployer owner", await curveDeployer.owner(), hre.ethers.ZeroAddress);
  const factoryBlock = await hre.ethers.provider.getBlock(factoryReceipt.blockNumber);
  const candidate = {
    network: current.network,
    chainId: current.chainId,
    contracts: {
      feeVault: feeVaultAddress,
      creatorRegistry: creatorRegistryAddress,
      curveDeployer: curveDeployerAddress,
      factory: factoryAddress,
      usdc: OFFICIAL_ARC_TESTNET_USDC,
    },
    deployer: deployer.address,
    feeRecipient: treasurySafe,
    emergencyGuardian,
    deployedAt: new Date(Number(factoryBlock.timestamp) * 1_000).toISOString(),
    explorerBaseUrl: current.explorerBaseUrl,
    status: "V6_CANDIDATE_DEPLOYED_REQUIRES_GOVERNANCE_HANDOFF",
    previousDeployment: {
      factory: current.contracts.factory,
      feeVault: current.contracts.feeVault,
      creatorRegistry: current.contracts.creatorRegistry,
    },
    legacyFactories: Array.from(new Set([current.contracts.factory, ...(current.legacyFactories ?? [])])),
    curveModel: {
      version: 6,
      virtualUsdcReserve: 2_500,
      graduationThreshold: 10_000,
      creatorFeeShareBps: 7_000,
      protocolFeeShareBps: 3_000,
      protectionBlocks: 3,
      maxProtectionHoldingBps: 500,
      maxProtectionPurchaseBps: 550,
      postGraduationVenue: "ARCFORGE_PERMANENT_AMM",
      creatorFeeMode: "PULL_CLAIM",
      dexMigrationReady: false,
      dexMigrationEnabled: false,
      migrationPaused: true,
    },
    migration: {
      type: "FACTORY_V6_FULL_STACK",
      factoryDeploymentTx: deploymentHashes.factory,
      factoryDeploymentBlock: factoryReceipt.blockNumber,
      vaultDeploymentTx: deploymentHashes.feeVault,
      vaultDeploymentBlock: feeVaultReceipt.blockNumber,
      registryDeploymentTx: deploymentHashes.creatorRegistry,
      registryDeploymentBlock: creatorRegistryReceipt.blockNumber,
      curveDeployerDeploymentTx: deploymentHashes.curveDeployer,
      curveDeployerDeploymentBlock: curveDeployerReceipt.blockNumber,
      configurationTransactions: configurationHashes,
      governanceHandoffComplete: false,
      activatedAt: null,
    },
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`);
  console.log(`Recovered and verified V6 candidate manifest at ${outputPath}.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
