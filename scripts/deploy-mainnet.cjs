const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_MAINNET_CHAIN_ID = 5_042n;
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const UNISWAP_V3_FACTORY = "0xf0db7b58379503491d857db50ac9ece64c653918";
const UNISWAP_V3_POSITION_MANAGER = "0x39654a85a4c05127f5fd6ed22caec077a0fb1377";
const LAUNCH_FEE = 10n * 10n ** 6n;
const outputPath = path.join(__dirname, "..", "deployment", "arc-mainnet.local.json");
const safeBatchPath = path.join(
  __dirname,
  "..",
  "deployment",
  "arc-mainnet-activation.safe.local.json",
);

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
    .filter(Boolean)
    .map((value) => {
      if (!hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
        throw new Error(`${name} contains an invalid address.`);
      }
      return hre.ethers.getAddress(value);
    });
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

async function requireContract(label, address) {
  if (await hre.ethers.provider.getCode(address) === "0x") {
    throw new Error(`${label} has no deployed bytecode on Arc mainnet.`);
  }
}

async function main() {
  requiredValue("ARC_MAINNET_RPC_URL");
  const expectedDeployer = requiredAddress("MAINNET_EXPECTED_DEPLOYER");
  const governanceSafe = requiredAddress("MAINNET_GOVERNANCE_SAFE");
  const expectedSafeOwners = requiredAddressList("MAINNET_GOVERNANCE_SAFE_OWNERS");
  const emergencyGuardian = requiredAddress("MAINNET_EMERGENCY_GUARDIAN");
  const retiredFactory = requiredAddress("MAINNET_RETIRED_FACTORY_ADDRESS");
  const protocolFeeRecipient = requiredAddress("MAINNET_PROTOCOL_FEE_RECIPIENT");
  const feeVault = requiredAddress("NEXT_PUBLIC_MAINNET_FEE_VAULT_ADDRESS");
  const creatorRegistry = requiredAddress("NEXT_PUBLIC_MAINNET_CREATOR_REGISTRY_ADDRESS");
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("MAINNET_DEPLOYER_PRIVATE_KEY is required.");
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, ARC_MAINNET_CHAIN_ID);
  assertEqual("deployer", deployer.address, expectedDeployer);
  const deployerBalance = await hre.ethers.provider.getBalance(deployer.address);
  if (deployerBalance === 0n) {
    throw new Error("Mainnet deployer has no native balance for gas.");
  }

  for (const [label, address] of [
    ["governance Safe", governanceSafe],
    ["emergency guardian", emergencyGuardian],
    ["retired Factory", retiredFactory],
    ["protocol fee recipient", protocolFeeRecipient],
    ["existing FeeVault", feeVault],
    ["existing CreatorRegistry", creatorRegistry],
    ["canonical Arc USDC", ARC_USDC],
    ["official Uniswap V3 Factory", UNISWAP_V3_FACTORY],
    ["official Uniswap V3 PositionManager", UNISWAP_V3_POSITION_MANAGER],
  ]) await requireContract(label, address);

  const safe = new hre.ethers.Contract(
    governanceSafe,
    [
      "function getOwners() view returns (address[])",
      "function getThreshold() view returns (uint256)",
    ],
    hre.ethers.provider,
  );
  const [safeOwners, safeThreshold] = await Promise.all([
    safe.getOwners(),
    safe.getThreshold(),
  ]);
  if (
    safeThreshold !== 2n ||
    safeOwners.length !== 3 ||
    new Set(safeOwners.map((owner) => owner.toLowerCase())).size !== 3 ||
    expectedSafeOwners.some(
      (owner) => !safeOwners.some((actual) => actual.toLowerCase() === owner.toLowerCase()),
    )
  ) {
    throw new Error("MAINNET_GOVERNANCE_SAFE must match the reviewed 2-of-3 owner set.");
  }
  const ownableAbi = ["function owner() view returns (address)"];
  for (const [label, address] of [["FeeVault", feeVault], ["CreatorRegistry", creatorRegistry]]) {
    const ownable = new hre.ethers.Contract(address, ownableAbi, hre.ethers.provider);
    assertEqual(`${label} owner`, await ownable.owner(), governanceSafe);
  }
  const retiredFactoryContract = new hre.ethers.Contract(
    retiredFactory,
    ["function owner() view returns (address)", "function paused() view returns (bool)"],
    hre.ethers.provider,
  );
  const vaultState = new hre.ethers.Contract(
    feeVault,
    [
      "function isRegistrar(address) view returns (bool)",
      "function isCollector(address) view returns (bool)",
      "function feeRecipient() view returns (address)",
    ],
    hre.ethers.provider,
  );
  const registryState = new hre.ethers.Contract(
    creatorRegistry,
    ["function factory() view returns (address)"],
    hre.ethers.provider,
  );
  assertEqual("retired Factory owner", await retiredFactoryContract.owner(), governanceSafe);
  assertEqual("active CreatorRegistry Factory", await registryState.factory(), retiredFactory);
  if (!(await vaultState.isRegistrar(retiredFactory))) {
    throw new Error("Retired Factory is not the active FeeVault registrar; review live ACL state.");
  }
  if (!(await vaultState.isCollector(retiredFactory))) {
    throw new Error("Retired Factory is not the active FeeVault collector; review live ACL state.");
  }
  if (
    process.env.DEPLOY_PREFLIGHT_ONLY !== "true" &&
    (fs.existsSync(outputPath) || fs.existsSync(safeBatchPath))
  ) {
    throw new Error("Refusing to overwrite an existing local deployment or Safe batch manifest.");
  }
  console.log("Arc mainnet preflight passed. Candidate will remain paused.");
  if (process.env.DEPLOY_PREFLIGHT_ONLY === "true") return;

  const Factory = await hre.ethers.getContractFactory("ArcForgeFactory");
  const factory = await Factory.deploy(
    governanceSafe,
    emergencyGuardian,
    ARC_USDC,
    feeVault,
    creatorRegistry,
    UNISWAP_V3_FACTORY,
    UNISWAP_V3_POSITION_MANAGER,
    LAUNCH_FEE,
  );
  const transaction = factory.deploymentTransaction();
  console.log(`Factory submitted: ${transaction.hash}`);
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error("Factory deployment reverted.");
  await factory.waitForDeployment();

  const factoryAddress = await factory.getAddress();
  const lockerAddress = await factory.liquidityLocker();
  const locker = await hre.ethers.getContractAt(
    "ArcOriginUniswapV3LiquidityLocker",
    lockerAddress,
  );
  assertEqual("factory owner", await factory.owner(), governanceSafe);
  assertEqual("launches paused", await factory.paused(), true);
  assertEqual("factory USDC", await factory.usdc(), ARC_USDC);
  assertEqual("V3 factory", await factory.uniswapV3Factory(), UNISWAP_V3_FACTORY);
  assertEqual("position manager", await factory.positionManager(), UNISWAP_V3_POSITION_MANAGER);
  assertEqual("launch fee", await factory.launchFee(), LAUNCH_FEE);
  assertEqual("locker factory", await locker.factory(), factoryAddress);
  assertEqual("locker position manager", await locker.positionManager(), UNISWAP_V3_POSITION_MANAGER);
  assertEqual("locker protocol recipient", await locker.protocolFeeRecipient(), feeVault);

  const vaultInterface = new hre.ethers.Interface([
    "function setRegistrar(address registrar,bool allowed)",
    "function setCollector(address collector,bool allowed)",
    "function setFeeRecipient(address newRecipient)",
  ]);
  const registryInterface = new hre.ethers.Interface([
    "function setFactory(address newFactory)",
  ]);
  const factoryInterface = new hre.ethers.Interface([
    "function pauseLaunches()",
    "function unpauseLaunches()",
  ]);
  const activationOperations = [
    {
      target: retiredFactory,
      value: "0",
      data: factoryInterface.encodeFunctionData("pauseLaunches"),
      purpose: "Retire launches from the previous Factory before changing shared ACLs",
    },
    {
      target: feeVault,
      value: "0",
      data: vaultInterface.encodeFunctionData("setRegistrar", [retiredFactory, false]),
      purpose: "Revoke the previous Factory registrar authority",
    },
    {
      target: feeVault,
      value: "0",
      data: vaultInterface.encodeFunctionData("setCollector", [retiredFactory, false]),
      purpose: "Revoke the previous Factory collector authority",
    },
    {
      target: feeVault,
      value: "0",
      data: vaultInterface.encodeFunctionData("setRegistrar", [factoryAddress, true]),
      purpose: "Authorize Factory to register launch fee collectors",
    },
    {
      target: feeVault,
      value: "0",
      data: vaultInterface.encodeFunctionData("setCollector", [factoryAddress, true]),
      purpose: "Authorize Factory launch fee collection",
    },
    {
      target: feeVault,
      value: "0",
      data: vaultInterface.encodeFunctionData("setFeeRecipient", [protocolFeeRecipient]),
      purpose: "Route protocol withdrawals to the reviewed Safe recipient",
    },
    {
      target: creatorRegistry,
      value: "0",
      data: registryInterface.encodeFunctionData("setFactory", [factoryAddress]),
      purpose: "Select the new Factory as the active launch factory",
    },
    {
      target: factoryAddress,
      value: "0",
      data: factoryInterface.encodeFunctionData("unpauseLaunches"),
      purpose: "Activate launches only after audit and UI cutover",
    },
  ];
  const manifest = {
    network: "arc-mainnet",
    chainId: Number(ARC_MAINNET_CHAIN_ID),
    status: "MAINNET_CANDIDATE_PAUSED_REQUIRES_AUDIT_AND_SAFE_ACTIVATION",
    contracts: {
      factory: factoryAddress,
      liquidityLocker: lockerAddress,
      feeVault,
      creatorRegistry,
      usdc: ARC_USDC,
      uniswapV3Factory: UNISWAP_V3_FACTORY,
      uniswapV3PositionManager: UNISWAP_V3_POSITION_MANAGER,
    },
    economics: {
      totalSupply: "1000000000",
      startMarketCapUsdc: 5_000,
      crossedMarketCapUsdc: 50_000,
      poolFee: 10_000,
      creatorFeeShareBps: 7_000,
      protocolFeeShareBps: 3_000,
      lpCustody: "PERMANENT_LOCKER_NO_WITHDRAWAL_PATH",
    },
    governance: { safe: governanceSafe, threshold: "2-of-3", emergencyGuardian },
    deploymentTransaction: transaction.hash,
    deploymentBlock: receipt.blockNumber,
    deployedAt: new Date().toISOString(),
    transition: {
      retiredFactory,
      retiredFactoryWasPaused: await retiredFactoryContract.paused(),
      previousProtocolFeeRecipient: await vaultState.feeRecipient(),
      protocolFeeRecipient,
    },
    activationOperations,
  };
  const safeBatch = {
    version: "1.0",
    chainId: String(ARC_MAINNET_CHAIN_ID),
    createdAt: Date.now(),
    meta: {
      name: "ArcOrigin mainnet activation",
      description: "Atomically retire old launches, rotate shared ACLs, select the reviewed Factory, and activate direct Uniswap pools.",
      createdFromSafeAddress: governanceSafe,
    },
    transactions: activationOperations.map((operation) => ({
      to: operation.target,
      value: operation.value,
      data: operation.data,
      contractMethod: null,
      contractInputsValues: null,
    })),
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(safeBatchPath, `${JSON.stringify(safeBatch, null, 2)}\n`);
  console.log(`Paused candidate manifest written to ${outputPath}`);
  console.log(`Unsigned Safe Transaction Builder batch written to ${safeBatchPath}`);
  console.log("STOP: do not execute activationOperations before independent review and UI cutover.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
