const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_MAINNET_CHAIN_ID = 5_042n;
const ARC_USDC_PREDEPLOY = "0x3600000000000000000000000000000000000000";
const LAUNCH_FEE = 10n * 10n ** 6n;
const VIRTUAL_RESERVE = 2_500n * 10n ** 6n;
const GRADUATION_THRESHOLD = 10_000n * 10n ** 6n;
const MINIMUM_TIMELOCK_DELAY = 2n * 24n * 60n * 60n;
const outputPath = path.join(__dirname, "..", "deployment", "arc-mainnet-v6.local.json");

const erc20MetadataAbi = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const safeAbi = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];
const timelockAbi = [
  "function getMinDelay() view returns (uint256)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
];

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

function requiredValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be explicitly configured.`);
  return value;
}

function requiredAddress(name) {
  const value = requiredValue(name);
  if (!hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero address.`);
  }
  return hre.ethers.getAddress(value);
}

async function requireContract(label, address) {
  if (await hre.ethers.provider.getCode(address) === "0x") {
    throw new Error(`${label} has no deployed bytecode on Arc mainnet.`);
  }
}

async function requireTwoOfThreeSafe(label, address) {
  await requireContract(label, address);
  const safe = new hre.ethers.Contract(address, safeAbi, hre.ethers.provider);
  const [owners, threshold] = await Promise.all([safe.getOwners(), safe.getThreshold()]);
  if (threshold !== 2n || owners.length !== 3) {
    throw new Error(`${label} must be exactly 2-of-3.`);
  }
  if (new Set(owners.map((owner) => owner.toLowerCase())).size !== 3) {
    throw new Error(`${label} contains duplicate owners.`);
  }
}

async function requireSafeTimelock(timelockAddress, governanceSafe, deployerAddress) {
  await requireContract("MAINNET_GOVERNANCE_TIMELOCK", timelockAddress);
  const timelock = new hre.ethers.Contract(
    timelockAddress,
    timelockAbi,
    hre.ethers.provider,
  );
  const delay = await timelock.getMinDelay();
  if (delay < MINIMUM_TIMELOCK_DELAY) {
    throw new Error("MAINNET_GOVERNANCE_TIMELOCK delay must be at least 48 hours.");
  }
  const roleChecks = [
    [await timelock.PROPOSER_ROLE(), governanceSafe, true, "Safe proposer"],
    [await timelock.CANCELLER_ROLE(), governanceSafe, true, "Safe canceller"],
    [await timelock.EXECUTOR_ROLE(), hre.ethers.ZeroAddress, true, "open executor"],
    [await timelock.DEFAULT_ADMIN_ROLE(), timelockAddress, true, "self admin"],
    [await timelock.DEFAULT_ADMIN_ROLE(), deployerAddress, false, "deployer admin"],
    [await timelock.DEFAULT_ADMIN_ROLE(), governanceSafe, false, "Safe direct admin"],
  ];
  for (const [role, account, expected, label] of roleChecks) {
    if (await timelock.hasRole(role, account) !== expected) {
      throw new Error(`Unsafe Timelock role layout: ${label} check failed for ${account}.`);
    }
  }
  return delay;
}

async function waitForDeployment(contract, label) {
  const transaction = contract.deploymentTransaction();
  console.log(`${label} submitted: ${transaction.hash}`);
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${label} deployment reverted.`);
  await contract.waitForDeployment();
  return {
    address: await contract.getAddress(),
    hash: transaction.hash,
    block: receipt.blockNumber,
  };
}

async function waitFor(transaction, label) {
  console.log(`${label}: ${transaction.hash}`);
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${label} reverted.`);
  return receipt;
}

async function main() {
  requiredValue("ARC_MAINNET_RPC_URL");
  const explorerBaseUrl = requiredValue("MAINNET_EXPLORER_URL").replace(/\/+$/, "");
  const expectedDeployer = requiredAddress("MAINNET_EXPECTED_DEPLOYER");
  const governanceSafe = requiredAddress("MAINNET_GOVERNANCE_SAFE");
  const treasurySafe = requiredAddress("MAINNET_TREASURY_SAFE");
  const emergencyGuardian = requiredAddress("MAINNET_EMERGENCY_GUARDIAN");
  const governanceTimelock = requiredAddress("MAINNET_GOVERNANCE_TIMELOCK");

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("MAINNET_DEPLOYER_PRIVATE_KEY is required.");
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, ARC_MAINNET_CHAIN_ID);
  assertEqual("deployer", deployer.address, expectedDeployer);
  await requireTwoOfThreeSafe("MAINNET_GOVERNANCE_SAFE", governanceSafe);
  await requireTwoOfThreeSafe("MAINNET_TREASURY_SAFE", treasurySafe);
  await requireTwoOfThreeSafe("MAINNET_EMERGENCY_GUARDIAN", emergencyGuardian);
  const governanceDelay = await requireSafeTimelock(
    governanceTimelock,
    governanceSafe,
    deployer.address,
  );
  await requireContract("canonical Arc USDC", ARC_USDC_PREDEPLOY);

  const usdc = new hre.ethers.Contract(
    ARC_USDC_PREDEPLOY,
    erc20MetadataAbi,
    hre.ethers.provider,
  );
  assertEqual("USDC decimals", await usdc.decimals(), 6);
  assertEqual("USDC symbol", await usdc.symbol(), "USDC");
  if ((await hre.ethers.provider.getBalance(deployer.address)) === 0n) {
    throw new Error("The deployer has no native Arc USDC for gas.");
  }
  if (fs.existsSync(outputPath) && process.env.DEPLOY_PREFLIGHT_ONLY !== "true") {
    throw new Error(`Refusing to overwrite ${outputPath}. Archive it before a new deployment.`);
  }

  console.log("Arc mainnet V6 preflight passed.");
  console.log("External DEX migration will be deployed disabled and paused.");
  if (process.env.DEPLOY_PREFLIGHT_ONLY === "true") return;

  const Vault = await hre.ethers.getContractFactory("ArcForgeFeeVaultV6");
  const vault = await Vault.deploy(deployer.address, treasurySafe);
  const vaultDeployment = await waitForDeployment(vault, "Mainnet V6 FeeVault");

  const Registry = await hre.ethers.getContractFactory("ArcForgeCreatorRegistryV6");
  const registry = await Registry.deploy(deployer.address);
  const registryDeployment = await waitForDeployment(registry, "Mainnet V6 CreatorRegistry");

  const CurveDeployer = await hre.ethers.getContractFactory("ArcForgeCurveDeployerV6");
  const curveDeployer = await CurveDeployer.deploy(deployer.address);
  const curveDeployerDeployment = await waitForDeployment(
    curveDeployer,
    "Mainnet V6 CurveDeployer",
  );

  const Factory = await hre.ethers.getContractFactory("ArcForgeFactoryV6");
  const factory = await Factory.deploy(
    deployer.address,
    emergencyGuardian,
    ARC_USDC_PREDEPLOY,
    vaultDeployment.address,
    registryDeployment.address,
    curveDeployerDeployment.address,
    LAUNCH_FEE,
    VIRTUAL_RESERVE,
    GRADUATION_THRESHOLD,
  );
  const factoryDeployment = await waitForDeployment(factory, "Mainnet V6 Factory");

  const configurationReceipts = [];
  configurationReceipts.push(await waitFor(
    await factory.pauseLaunches(),
    "Pause mainnet launches before protocol activation",
  ));
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
    "Select V6 Factory in isolated Registry",
  ));

  assertEqual("factory owner", await factory.owner(), deployer.address);
  assertEqual("factory guardian", await factory.emergencyGuardian(), emergencyGuardian);
  assertEqual("factory USDC", await factory.usdc(), ARC_USDC_PREDEPLOY);
  assertEqual("launch fee", await factory.launchFee(), LAUNCH_FEE);
  assertEqual("virtual reserve", await factory.virtualUsdcReserve(), VIRTUAL_RESERVE);
  assertEqual("graduation target", await factory.graduationThreshold(), GRADUATION_THRESHOLD);
  assertEqual("migration adapter", await factory.dexMigrationAdapter(), hre.ethers.ZeroAddress);
  assertEqual("migration paused", await factory.migrationPaused(), true);
  assertEqual("launches paused", await factory.paused(), true);
  assertEqual("vault recipient", await vault.feeRecipient(), treasurySafe);
  assertEqual("vault registrar", await vault.isRegistrar(factoryDeployment.address), true);
  assertEqual("vault collector", await vault.isCollector(factoryDeployment.address), true);
  assertEqual("registry factory", await registry.factory(), factoryDeployment.address);
  assertEqual("curve deployer factory", await curveDeployer.factory(), factoryDeployment.address);
  assertEqual("curve deployer owner", await curveDeployer.owner(), hre.ethers.ZeroAddress);

  const candidate = {
    network: "arc-mainnet",
    chainId: Number(ARC_MAINNET_CHAIN_ID),
    contracts: {
      feeVault: vaultDeployment.address,
      creatorRegistry: registryDeployment.address,
      curveDeployer: curveDeployerDeployment.address,
      factory: factoryDeployment.address,
      usdc: ARC_USDC_PREDEPLOY,
    },
    deployer: deployer.address,
    feeRecipient: treasurySafe,
    emergencyGuardian,
    governance: {
      safe: governanceSafe,
      timelock: governanceTimelock,
      minimumDelaySeconds: governanceDelay.toString(),
      handoffComplete: false,
    },
    deployedAt: new Date().toISOString(),
    explorerBaseUrl,
    status: "V6_MAINNET_CANDIDATE_PAUSED_REQUIRES_MIGRATION_VERIFICATION_AND_GOVERNANCE",
    curveModel: {
      version: 6,
      virtualUsdcReserve: 2_500,
      graduationThreshold: 10_000,
      creatorFeeShareBps: 7_000,
      protocolFeeShareBps: 3_000,
      protectionBlocks: 3,
      maxProtectionHoldingBps: 500,
      maxProtectionPurchaseBps: 550,
      postGraduationVenue:
        "INTERNAL_AMM_UNTIL_VERIFIED_UNISWAP_V3_MIGRATION",
      creatorFeeMode: "PULL_CLAIM",
    },
    dexMigration: {
      target: "UNISWAP",
      configured: false,
      enabled: false,
      paused: true,
      adapter: null,
      locker: null,
      verifier: null,
      reason: "Requires verified Uniswap deployment addresses, adapter audit, and timelocked governance approval.",
    },
    deploymentTransactions: {
      factory: factoryDeployment.hash,
      feeVault: vaultDeployment.hash,
      creatorRegistry: registryDeployment.hash,
      curveDeployer: curveDeployerDeployment.hash,
      configuration: configurationReceipts.map((receipt) => receipt.hash),
    },
    deploymentBlocks: {
      factory: factoryDeployment.block,
      feeVault: vaultDeployment.block,
      creatorRegistry: registryDeployment.block,
      curveDeployer: curveDeployerDeployment.block,
    },
    governanceHandoffComplete: false,
    launchesPaused: true,
    activatedAt: null,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`);
  console.log(`Mainnet candidate manifest written to ${outputPath}`);
  console.log("STOP: launches are paused. Do not activate the UI or unpause the Factory.");
  console.log("First verify source, configure the reviewed migration stack, run readiness checks, and complete governance handoff.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
