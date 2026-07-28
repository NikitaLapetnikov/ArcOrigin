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

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

function requiredAddress(name) {
  const value = process.env[name];
  if (!value || !hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
    throw new Error(`${name} must be an explicitly configured non-zero address.`);
  }
  return hre.ethers.getAddress(value);
}

async function requireContract(label, address) {
  if (await hre.ethers.provider.getCode(address) === "0x") {
    throw new Error(`${label} must be a deployed contract, preferably a reviewed Safe.`);
  }
}

async function waitForDeployment(contract, label) {
  const transaction = contract.deploymentTransaction();
  console.log(`${label} submitted: ${transaction.hash}`);
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${label} deployment reverted.`);
  await contract.waitForDeployment();
  return { address: await contract.getAddress(), hash: transaction.hash, block: receipt.blockNumber };
}

async function waitFor(transaction, label) {
  console.log(`${label}: ${transaction.hash}`);
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${label} reverted.`);
  return receipt;
}

async function main() {
  const current = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  if (fs.existsSync(outputPath) && process.env.DEPLOY_PREFLIGHT_ONLY !== "true") {
    throw new Error(`Refusing to overwrite existing candidate manifest at ${outputPath}.`);
  }
  const treasurySafe = requiredAddress("TREASURY_SAFE");
  const emergencyGuardian = requiredAddress("EMERGENCY_GUARDIAN");
  await requireContract("TREASURY_SAFE", treasurySafe);
  await requireContract("EMERGENCY_GUARDIAN", emergencyGuardian);

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is required.");
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, ARC_TESTNET_CHAIN_ID);
  assertEqual("deployer", deployer.address, current.deployer);
  assertEqual("USDC", current.contracts.usdc, OFFICIAL_ARC_TESTNET_USDC);
  const usdcCode = await hre.ethers.provider.getCode(OFFICIAL_ARC_TESTNET_USDC);
  if (usdcCode === "0x") throw new Error("Official Arc Testnet USDC has no bytecode.");
  if ((await hre.ethers.provider.getBalance(deployer.address)) === 0n) {
    throw new Error("The deployer has no native Arc Testnet gas balance.");
  }
  console.log("V6 preflight passed. Migration is deployed disabled and paused.");
  if (process.env.DEPLOY_PREFLIGHT_ONLY === "true") return;

  const Vault = await hre.ethers.getContractFactory("ArcForgeFeeVaultV6");
  const vault = await Vault.deploy(deployer.address, treasurySafe);
  const vaultDeployment = await waitForDeployment(vault, "V6 FeeVault");

  const Registry = await hre.ethers.getContractFactory("ArcForgeCreatorRegistryV6");
  const registry = await Registry.deploy(deployer.address);
  const registryDeployment = await waitForDeployment(registry, "V6 CreatorRegistry");

  const CurveDeployer = await hre.ethers.getContractFactory("ArcForgeCurveDeployerV6");
  const curveDeployer = await CurveDeployer.deploy(deployer.address);
  const curveDeployerDeployment = await waitForDeployment(curveDeployer, "V6 CurveDeployer");

  const Factory = await hre.ethers.getContractFactory("ArcForgeFactoryV6");
  const factory = await Factory.deploy(
    deployer.address,
    emergencyGuardian,
    OFFICIAL_ARC_TESTNET_USDC,
    vaultDeployment.address,
    registryDeployment.address,
    curveDeployerDeployment.address,
    LAUNCH_FEE,
    VIRTUAL_RESERVE,
    GRADUATION_THRESHOLD,
  );
  const factoryDeployment = await waitForDeployment(factory, "V6 Factory");

  const configurationReceipts = [];
  configurationReceipts.push(await waitFor(
    await curveDeployer.bindFactory(factoryDeployment.address),
    "Bind one-time CurveDeployer",
  ));
  configurationReceipts.push(await waitFor(
    await vault.setRegistrar(factoryDeployment.address, true),
    "Authorize Factory as collector registrar",
  ));
  configurationReceipts.push(await waitFor(
    await vault.setCollector(factoryDeployment.address, true),
    "Authorize Factory fee collection",
  ));
  configurationReceipts.push(await waitFor(
    await registry.setFactory(factoryDeployment.address),
    "Select V6 Factory in isolated V6 Registry",
  ));

  assertEqual("factory owner", await factory.owner(), deployer.address);
  assertEqual("factory guardian", await factory.emergencyGuardian(), emergencyGuardian);
  assertEqual("factory USDC", await factory.usdc(), OFFICIAL_ARC_TESTNET_USDC);
  assertEqual("launch fee", await factory.launchFee(), LAUNCH_FEE);
  assertEqual("virtual reserve", await factory.virtualUsdcReserve(), VIRTUAL_RESERVE);
  assertEqual("graduation target", await factory.graduationThreshold(), GRADUATION_THRESHOLD);
  assertEqual("migration adapter", await factory.dexMigrationAdapter(), hre.ethers.ZeroAddress);
  assertEqual("migration paused", await factory.migrationPaused(), true);
  assertEqual("vault recipient", await vault.feeRecipient(), treasurySafe);
  assertEqual("vault registrar", await vault.isRegistrar(factoryDeployment.address), true);
  assertEqual("vault collector", await vault.isCollector(factoryDeployment.address), true);
  assertEqual("registry factory", await registry.factory(), factoryDeployment.address);
  assertEqual("curve deployer factory", await curveDeployer.factory(), factoryDeployment.address);
  assertEqual("curve deployer owner", await curveDeployer.owner(), hre.ethers.ZeroAddress);

  const candidate = {
    network: current.network,
    chainId: current.chainId,
    contracts: {
      feeVault: vaultDeployment.address,
      creatorRegistry: registryDeployment.address,
      curveDeployer: curveDeployerDeployment.address,
      factory: factoryDeployment.address,
      usdc: OFFICIAL_ARC_TESTNET_USDC,
    },
    deployer: deployer.address,
    feeRecipient: treasurySafe,
    emergencyGuardian,
    deployedAt: new Date().toISOString(),
    explorerBaseUrl: current.explorerBaseUrl,
    status: "V6_CANDIDATE_DEPLOYED_REQUIRES_GOVERNANCE_HANDOFF",
    previousDeployment: {
      factory: current.contracts.factory,
      feeVault: current.contracts.feeVault,
      creatorRegistry: current.contracts.creatorRegistry,
    },
    legacyFactories: Array.from(new Set([
      current.contracts.factory,
      ...(current.legacyFactories ?? []),
    ])),
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
      factoryDeploymentTx: factoryDeployment.hash,
      factoryDeploymentBlock: factoryDeployment.block,
      vaultDeploymentTx: vaultDeployment.hash,
      registryDeploymentTx: registryDeployment.hash,
      curveDeployerDeploymentTx: curveDeployerDeployment.hash,
      configurationTransactions: configurationReceipts.map((receipt) => receipt.hash),
      governanceHandoffComplete: false,
      activatedAt: null,
    },
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`);
  console.log(`V6 candidate manifest written to ${outputPath}`);
  console.log("Do not activate it until bytecode verification, governance handoff, and UI compatibility checks pass.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
