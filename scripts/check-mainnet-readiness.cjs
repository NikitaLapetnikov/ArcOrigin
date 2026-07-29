const hre = require("hardhat");

const ARC_MAINNET_CHAIN_ID = 5_042n;
const ARC_USDC_PREDEPLOY = "0x3600000000000000000000000000000000000000";

const factoryAbi = [
  "function owner() view returns (address)",
  "function emergencyGuardian() view returns (address)",
  "function usdc() view returns (address)",
  "function feeVault() view returns (address)",
  "function creatorRegistry() view returns (address)",
  "function curveDeployer() view returns (address)",
  "function paused() view returns (bool)",
  "function migrationPaused() view returns (bool)",
  "function dexMigrationAdapter() view returns (address)",
  "function liquidityLocker() view returns (address)",
  "function migrationVerifier() view returns (address)",
  "function currentMigrationConfigurationHash() view returns (bytes32)",
];
const ownableAbi = ["function owner() view returns (address)"];
const vaultAbi = [
  ...ownableAbi,
  "function feeRecipient() view returns (address)",
  "function isRegistrar(address) view returns (bool)",
  "function isCollector(address) view returns (bool)",
];
const registryAbi = [...ownableAbi, "function factory() view returns (address)"];
const curveDeployerAbi = [...ownableAbi, "function factory() view returns (address)"];
const erc20MetadataAbi = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const v3PositionManagerAbi = ["function factory() view returns (address)"];
const migrationAdapterAbi = [
  "function migrationController() view returns (address)",
  "function v3Factory() view returns (address)",
  "function positionManager() view returns (address)",
  "function quoteToken() view returns (address)",
  "function POOL_FEE() view returns (uint24)",
  "function CREATOR_FEE_SHARE_BPS() view returns (uint16)",
  "function MIN_LIQUIDITY_USAGE_BPS() view returns (uint16)",
];
const liquidityLockerAbi = [
  "function adapter() view returns (address)",
  "function positionManager() view returns (address)",
  "function protocolFeeRecipient() view returns (address)",
];
const migrationVerifierAbi = [
  "function migrationController() view returns (address)",
  "function v3Factory() view returns (address)",
  "function positionManager() view returns (address)",
  "function quoteToken() view returns (address)",
  "function adapter() view returns (address)",
  "function locker() view returns (address)",
];
const safeAbi = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];

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

function requiredAddressList(name) {
  const values = requiredValue(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${name} must contain at least one address.`);
  }
  return values.map((value) => {
    if (!hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
      throw new Error(`${name} contains an invalid address: ${value}.`);
    }
    return hre.ethers.getAddress(value);
  });
}

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

async function contractCode(label, address) {
  const code = await hre.ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`${label} has no deployed bytecode at ${address}.`);
  return code;
}

async function verifiedCodeHash(label, address, envName) {
  const codeHash = hre.ethers.keccak256(await contractCode(label, address));
  const expected = requiredValue(envName);
  if (!hre.ethers.isHexString(expected, 32)) {
    throw new Error(`${envName} must be a 32-byte runtime bytecode hash.`);
  }
  assertEqual(`${label} runtime bytecode hash`, codeHash, expected);
  return codeHash;
}

async function main() {
  requiredValue("ARC_MAINNET_RPC_URL");
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, ARC_MAINNET_CHAIN_ID);

  const factoryAddress = requiredAddress("NEXT_PUBLIC_MAINNET_FACTORY_ADDRESS");
  const vaultAddress = requiredAddress("NEXT_PUBLIC_MAINNET_FEE_VAULT_ADDRESS");
  const registryAddress = requiredAddress("NEXT_PUBLIC_MAINNET_CREATOR_REGISTRY_ADDRESS");
  const curveDeployerAddress = requiredAddress("MAINNET_CURVE_DEPLOYER_ADDRESS");
  const governanceSafe = requiredAddress("MAINNET_GOVERNANCE_SAFE");
  const expectedSafeOwners = requiredAddressList("MAINNET_GOVERNANCE_SAFE_OWNERS");
  const treasurySafe = requiredAddress("MAINNET_TREASURY_SAFE");
  const emergencyGuardian = requiredAddress("MAINNET_EMERGENCY_GUARDIAN");

  await Promise.all([
    contractCode("Factory V6", factoryAddress),
    contractCode("FeeVault V6", vaultAddress),
    contractCode("CreatorRegistry V6", registryAddress),
    contractCode("CurveDeployer V6", curveDeployerAddress),
    contractCode("Governance Safe", governanceSafe),
    contractCode("Treasury Safe", treasurySafe),
    contractCode("Emergency guardian", emergencyGuardian),
    contractCode("Arc USDC", ARC_USDC_PREDEPLOY),
  ]);

  const factory = new hre.ethers.Contract(factoryAddress, factoryAbi, hre.ethers.provider);
  const vault = new hre.ethers.Contract(vaultAddress, vaultAbi, hre.ethers.provider);
  const registry = new hre.ethers.Contract(registryAddress, registryAbi, hre.ethers.provider);
  const curveDeployer = new hre.ethers.Contract(
    curveDeployerAddress,
    curveDeployerAbi,
    hre.ethers.provider,
  );
  const usdc = new hre.ethers.Contract(
    ARC_USDC_PREDEPLOY,
    erc20MetadataAbi,
    hre.ethers.provider,
  );
  const safe = new hre.ethers.Contract(governanceSafe, safeAbi, hre.ethers.provider);
  const [safeOwners, safeThreshold] = await Promise.all([
    safe.getOwners(),
    safe.getThreshold(),
  ]);
  assertEqual("Governance Safe threshold", safeThreshold, 2);
  assertEqual("Governance Safe owner count", safeOwners.length, 3);
  assertEqual("reviewed Safe owner count", expectedSafeOwners.length, 3);
  const actualOwnerSet = new Set(safeOwners.map((owner) => owner.toLowerCase()));
  const expectedOwnerSet = new Set(
    expectedSafeOwners.map((owner) => owner.toLowerCase()),
  );
  if (
    actualOwnerSet.size !== 3 ||
    expectedOwnerSet.size !== 3 ||
    [...expectedOwnerSet].some((owner) => !actualOwnerSet.has(owner))
  ) {
    throw new Error(
      `Governance Safe owner mismatch: expected ${expectedSafeOwners.join(", ")}, received ${safeOwners.join(", ")}.`,
    );
  }

  assertEqual("USDC decimals", await usdc.decimals(), 6);
  assertEqual("USDC symbol", await usdc.symbol(), "USDC");
  assertEqual("Factory owner", await factory.owner(), governanceSafe);
  assertEqual("Factory guardian", await factory.emergencyGuardian(), emergencyGuardian);
  assertEqual("Factory USDC", await factory.usdc(), ARC_USDC_PREDEPLOY);
  assertEqual("Factory FeeVault", await factory.feeVault(), vaultAddress);
  assertEqual("Factory Registry", await factory.creatorRegistry(), registryAddress);
  assertEqual("Factory CurveDeployer", await factory.curveDeployer(), curveDeployerAddress);
  assertEqual("FeeVault owner", await vault.owner(), governanceSafe);
  assertEqual("FeeVault recipient", await vault.feeRecipient(), treasurySafe);
  assertEqual("FeeVault registrar", await vault.isRegistrar(factoryAddress), true);
  assertEqual("FeeVault collector", await vault.isCollector(factoryAddress), true);
  assertEqual("Registry owner", await registry.owner(), governanceSafe);
  assertEqual("Registry Factory", await registry.factory(), factoryAddress);
  assertEqual("CurveDeployer owner renounced", await curveDeployer.owner(), hre.ethers.ZeroAddress);
  assertEqual("CurveDeployer Factory", await curveDeployer.factory(), factoryAddress);

  const adapter = requiredAddress("ARCORIGIN_MIGRATION_ADAPTER");
  const locker = requiredAddress("ARCORIGIN_LIQUIDITY_LOCKER");
  const verifier = requiredAddress("ARCORIGIN_MIGRATION_VERIFIER");
  const migrationCodeHashes = {
    adapter: await verifiedCodeHash(
      "ArcOrigin migration adapter",
      adapter,
      "ARCORIGIN_MIGRATION_ADAPTER_CODEHASH",
    ),
    locker: await verifiedCodeHash(
      "ArcOrigin liquidity locker",
      locker,
      "ARCORIGIN_LIQUIDITY_LOCKER_CODEHASH",
    ),
    verifier: await verifiedCodeHash(
      "ArcOrigin migration verifier",
      verifier,
      "ARCORIGIN_MIGRATION_VERIFIER_CODEHASH",
    ),
  };
  assertEqual("Factory migration adapter", await factory.dexMigrationAdapter(), adapter);
  assertEqual("Factory liquidity locker", await factory.liquidityLocker(), locker);
  assertEqual("Factory migration verifier", await factory.migrationVerifier(), verifier);
  if ((await factory.currentMigrationConfigurationHash()) === hre.ethers.ZeroHash) {
    throw new Error("Factory migration configuration hash is empty.");
  }
  const migrationAdapter = new hre.ethers.Contract(
    adapter,
    migrationAdapterAbi,
    hre.ethers.provider,
  );
  const liquidityLocker = new hre.ethers.Contract(
    locker,
    liquidityLockerAbi,
    hre.ethers.provider,
  );
  const migrationVerifier = new hre.ethers.Contract(
    verifier,
    migrationVerifierAbi,
    hre.ethers.provider,
  );
  assertEqual(
    "MigrationAdapter controller",
    await migrationAdapter.migrationController(),
    factoryAddress,
  );
  assertEqual(
    "MigrationAdapter quote token",
    await migrationAdapter.quoteToken(),
    ARC_USDC_PREDEPLOY,
  );
  assertEqual("MigrationAdapter fee tier", await migrationAdapter.POOL_FEE(), 10_000);
  assertEqual(
    "MigrationAdapter creator split",
    await migrationAdapter.CREATOR_FEE_SHARE_BPS(),
    7_000,
  );
  assertEqual(
    "MigrationAdapter minimum asset usage",
    await migrationAdapter.MIN_LIQUIDITY_USAGE_BPS(),
    9_990,
  );
  assertEqual("LiquidityLocker adapter", await liquidityLocker.adapter(), adapter);
  assertEqual(
    "LiquidityLocker protocol recipient",
    await liquidityLocker.protocolFeeRecipient(),
    vaultAddress,
  );
  assertEqual(
    "MigrationVerifier controller",
    await migrationVerifier.migrationController(),
    factoryAddress,
  );
  assertEqual(
    "MigrationVerifier quote token",
    await migrationVerifier.quoteToken(),
    ARC_USDC_PREDEPLOY,
  );
  assertEqual("MigrationVerifier adapter", await migrationVerifier.adapter(), adapter);
  assertEqual("MigrationVerifier locker", await migrationVerifier.locker(), locker);

  const uniswapVersion = requiredValue("UNISWAP_MIGRATION_VERSION").toLowerCase();
  if (uniswapVersion !== "v3") {
    throw new Error(
      "This ArcOrigin release implements only the reviewed Uniswap V3 migration path.",
    );
  }
  const uniswap = { version: uniswapVersion };
  const v3Factory = requiredAddress("UNISWAP_V3_FACTORY");
  const positionManager = requiredAddress("UNISWAP_V3_POSITION_MANAGER");
  const quoter = requiredAddress("UNISWAP_V3_QUOTER");
  const swapRouter = requiredAddress("UNISWAP_V3_SWAP_ROUTER");
  assertEqual(
    "public Uniswap V3 Factory",
    requiredAddress("NEXT_PUBLIC_UNISWAP_V3_FACTORY"),
    v3Factory,
  );
  assertEqual(
    "public Uniswap V3 PositionManager",
    requiredAddress("NEXT_PUBLIC_UNISWAP_V3_POSITION_MANAGER"),
    positionManager,
  );
  assertEqual(
    "public Uniswap V3 Quoter",
    requiredAddress("NEXT_PUBLIC_UNISWAP_V3_QUOTER"),
    quoter,
  );
  assertEqual(
    "public Uniswap V3 SwapRouter",
    requiredAddress("NEXT_PUBLIC_UNISWAP_V3_ROUTER"),
    swapRouter,
  );
  uniswap.factoryCodeHash = await verifiedCodeHash(
    "Uniswap V3 Factory",
    v3Factory,
    "UNISWAP_V3_FACTORY_CODEHASH",
  );
  uniswap.positionManagerCodeHash = await verifiedCodeHash(
    "Uniswap V3 PositionManager",
    positionManager,
    "UNISWAP_V3_POSITION_MANAGER_CODEHASH",
  );
  uniswap.quoterCodeHash = await verifiedCodeHash(
    "Uniswap V3 Quoter",
    quoter,
    "UNISWAP_V3_QUOTER_CODEHASH",
  );
  uniswap.swapRouterCodeHash = await verifiedCodeHash(
    "Uniswap V3 SwapRouter02",
    swapRouter,
    "UNISWAP_V3_SWAP_ROUTER_CODEHASH",
  );
  const manager = new hre.ethers.Contract(
    positionManager,
    v3PositionManagerAbi,
    hre.ethers.provider,
  );
  assertEqual("Uniswap V3 PositionManager Factory", await manager.factory(), v3Factory);
  assertEqual(
    "MigrationAdapter V3 Factory",
    await migrationAdapter.v3Factory(),
    v3Factory,
  );
  assertEqual(
    "MigrationAdapter PositionManager",
    await migrationAdapter.positionManager(),
    positionManager,
  );
  assertEqual(
    "LiquidityLocker PositionManager",
    await liquidityLocker.positionManager(),
    positionManager,
  );
  assertEqual(
    "MigrationVerifier V3 Factory",
    await migrationVerifier.v3Factory(),
    v3Factory,
  );
  assertEqual(
    "MigrationVerifier PositionManager",
    await migrationVerifier.positionManager(),
    positionManager,
  );
  uniswap.factory = v3Factory;
  uniswap.positionManager = positionManager;
  uniswap.quoter = quoter;
  uniswap.swapRouter = swapRouter;

  const expectedLaunchesPaused = process.env.MAINNET_EXPECT_LAUNCHES_PAUSED !== "false";
  assertEqual("Factory launch pause", await factory.paused(), expectedLaunchesPaused);
  assertEqual("Factory migration pause", await factory.migrationPaused(), true);

  const humanChecks = {
    sourceVerificationConfirmed:
      process.env.MAINNET_SOURCE_VERIFICATION_CONFIRMED === "true",
    independentAuditApproved:
      process.env.MAINNET_INDEPENDENT_AUDIT_APPROVED === "true",
    reorgIndexerTested:
      process.env.MAINNET_INDEXER_REORG_TESTED === "true",
    monitoringAlertsTested:
      process.env.MAINNET_MONITORING_TESTED === "true",
  };
  const missingHumanChecks = Object.entries(humanChecks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);

  const report = {
    readyForActivation: missingHumanChecks.length === 0,
    chainId: Number(network.chainId),
    factory: factoryAddress,
    launchesPaused: await factory.paused(),
    migrationsPaused: await factory.migrationPaused(),
    governance: {
      mode: "DIRECT_SAFE_2_OF_3",
      safe: governanceSafe,
      safeOwners,
      safeThreshold: Number(safeThreshold),
      treasurySafe,
      emergencyGuardian,
    },
    migration: { adapter, locker, verifier, codeHashes: migrationCodeHashes },
    uniswap,
    humanChecks,
    missingHumanChecks,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.readyForActivation) {
    throw new Error(`Mainnet activation is blocked by: ${missingHumanChecks.join(", ")}.`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
