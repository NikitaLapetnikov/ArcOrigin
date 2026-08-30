const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_MAINNET_CHAIN_ID = 5_042n;
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const UNISWAP_V3_FACTORY = "0xf0db7b58379503491d857db50ac9ece64c653918";
const UNISWAP_V3_POSITION_MANAGER = "0x39654a85a4c05127f5fd6ed22caec077a0fb1377";
const UNISWAP_V3_SWAP_ROUTER = "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77";
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

async function retry(label, operation, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts.`, { cause: lastError });
}

async function main() {
  requiredValue("ARC_MAINNET_RPC_URL");
  const transactionHash = requiredValue("MAINNET_DEPLOYMENT_TRANSACTION");
  if (!hre.ethers.isHexString(transactionHash, 32)) {
    throw new Error("MAINNET_DEPLOYMENT_TRANSACTION must be a transaction hash.");
  }
  const expectedDeployer = requiredAddress("MAINNET_EXPECTED_DEPLOYER");
  const governanceSafe = requiredAddress("MAINNET_GOVERNANCE_SAFE");
  const expectedSafeOwners = requiredAddressList("MAINNET_GOVERNANCE_SAFE_OWNERS");
  const emergencyGuardian = requiredAddress("MAINNET_EMERGENCY_GUARDIAN");
  const retiredFactory = requiredAddress("MAINNET_RETIRED_FACTORY_ADDRESS");
  const protocolFeeRecipient = requiredAddress("MAINNET_PROTOCOL_FEE_RECIPIENT");
  const feeVault = requiredAddress("NEXT_PUBLIC_MAINNET_FEE_VAULT_ADDRESS");
  const creatorRegistry = requiredAddress("NEXT_PUBLIC_MAINNET_CREATOR_REGISTRY_ADDRESS");
  if (fs.existsSync(outputPath) || fs.existsSync(safeBatchPath)) {
    throw new Error("Refusing to overwrite an existing recovered manifest or Safe batch.");
  }

  const network = await retry("network read", () => hre.ethers.provider.getNetwork());
  assertEqual("chain ID", network.chainId, ARC_MAINNET_CHAIN_ID);
  const [transaction, receipt] = await Promise.all([
    retry("deployment transaction read", () => hre.ethers.provider.getTransaction(transactionHash)),
    retry("deployment receipt read", () => hre.ethers.provider.getTransactionReceipt(transactionHash)),
  ]);
  if (!transaction || !receipt || receipt.status !== 1 || !receipt.contractAddress) {
    throw new Error("Deployment transaction is missing, failed, or did not create a contract.");
  }
  assertEqual("deployment sender", transaction.from, expectedDeployer);
  const factoryAddress = hre.ethers.getAddress(receipt.contractAddress);
  const factory = await hre.ethers.getContractAt("ArcForgeFactory", factoryAddress);
  const lockerAddress = await retry("Locker address read", () => factory.liquidityLocker());
  const locker = await hre.ethers.getContractAt(
    "ArcOriginUniswapV3LiquidityLocker",
    lockerAddress,
  );
  const safe = new hre.ethers.Contract(
    governanceSafe,
    ["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)"],
    hre.ethers.provider,
  );
  const retired = new hre.ethers.Contract(
    retiredFactory,
    ["function owner() view returns (address)", "function paused() view returns (bool)"],
    hre.ethers.provider,
  );
  const vault = new hre.ethers.Contract(
    feeVault,
    [
      "function owner() view returns (address)",
      "function feeRecipient() view returns (address)",
      "function isRegistrar(address) view returns (bool)",
      "function isCollector(address) view returns (bool)",
    ],
    hre.ethers.provider,
  );
  const registry = new hre.ethers.Contract(
    creatorRegistry,
    ["function owner() view returns (address)", "function factory() view returns (address)"],
    hre.ethers.provider,
  );

  const state = await retry("candidate state verification", async () => {
    const [
      safeOwners,
      safeThreshold,
      factoryOwner,
      factoryPaused,
      factoryGuardian,
      factoryUsdc,
      factoryVault,
      factoryRegistry,
      factoryV3,
      factoryManager,
      factoryRouter,
      factoryLaunchFee,
      launchCount,
      lockerFactory,
      lockerManager,
      lockerRouter,
      lockerQuoteToken,
      lockerRecipient,
      retiredOwner,
      retiredPaused,
      retiredRegistrar,
      retiredCollector,
      vaultOwner,
      previousFeeRecipient,
      registryOwner,
      registryFactory,
    ] = await Promise.all([
      safe.getOwners(), safe.getThreshold(), factory.owner(), factory.paused(),
      factory.emergencyGuardian(), factory.usdc(), factory.feeVault(), factory.creatorRegistry(),
      factory.uniswapV3Factory(), factory.positionManager(), factory.swapRouter(), factory.launchFee(),
      factory.getLaunchedTokenCount(), locker.factory(), locker.positionManager(),
      locker.swapRouter(), locker.quoteToken(), locker.protocolFeeRecipient(), retired.owner(), retired.paused(),
      vault.isRegistrar(retiredFactory), vault.isCollector(retiredFactory), vault.owner(),
      vault.feeRecipient(), registry.owner(), registry.factory(),
    ]);
    return {
      safeOwners, safeThreshold, factoryOwner, factoryPaused, factoryGuardian,
      factoryUsdc, factoryVault, factoryRegistry, factoryV3, factoryManager, factoryRouter,
      factoryLaunchFee, launchCount, lockerFactory, lockerManager, lockerRouter,
      lockerQuoteToken, lockerRecipient,
      retiredOwner, retiredPaused, retiredRegistrar, retiredCollector, vaultOwner,
      previousFeeRecipient, registryOwner, registryFactory,
    };
  });

  if (
    state.safeThreshold !== 2n ||
    state.safeOwners.length !== 3 ||
    expectedSafeOwners.some(
      (owner) => !state.safeOwners.some((actual) => actual.toLowerCase() === owner.toLowerCase()),
    )
  ) throw new Error("Governance Safe owner set or threshold mismatch.");
  assertEqual("Factory owner", state.factoryOwner, governanceSafe);
  assertEqual("Factory paused", state.factoryPaused, true);
  assertEqual("Factory guardian", state.factoryGuardian, emergencyGuardian);
  assertEqual("Factory USDC", state.factoryUsdc, ARC_USDC);
  assertEqual("Factory FeeVault", state.factoryVault, feeVault);
  assertEqual("Factory Registry", state.factoryRegistry, creatorRegistry);
  assertEqual("Factory Uniswap Factory", state.factoryV3, UNISWAP_V3_FACTORY);
  assertEqual("Factory PositionManager", state.factoryManager, UNISWAP_V3_POSITION_MANAGER);
  assertEqual("Factory SwapRouter", state.factoryRouter, UNISWAP_V3_SWAP_ROUTER);
  assertEqual("Factory launch fee", state.factoryLaunchFee, LAUNCH_FEE);
  assertEqual("Factory launch count", state.launchCount, 0);
  assertEqual("Locker Factory", state.lockerFactory, factoryAddress);
  assertEqual("Locker PositionManager", state.lockerManager, UNISWAP_V3_POSITION_MANAGER);
  assertEqual("Locker SwapRouter", state.lockerRouter, UNISWAP_V3_SWAP_ROUTER);
  assertEqual("Locker quote token", state.lockerQuoteToken, ARC_USDC);
  assertEqual("Locker protocol recipient", state.lockerRecipient, feeVault);
  assertEqual("retired Factory owner", state.retiredOwner, governanceSafe);
  assertEqual("retired Factory registrar", state.retiredRegistrar, true);
  assertEqual("retired Factory collector", state.retiredCollector, true);
  assertEqual("FeeVault owner", state.vaultOwner, governanceSafe);
  assertEqual("CreatorRegistry owner", state.registryOwner, governanceSafe);
  assertEqual("CreatorRegistry current Factory", state.registryFactory, retiredFactory);

  const vaultInterface = new hre.ethers.Interface([
    "function setRegistrar(address registrar,bool allowed)",
    "function setCollector(address collector,bool allowed)",
    "function setFeeRecipient(address newRecipient)",
  ]);
  const registryInterface = new hre.ethers.Interface(["function setFactory(address newFactory)"]);
  const factoryInterface = new hre.ethers.Interface([
    "function pauseLaunches()",
    "function unpauseLaunches()",
  ]);
  const activationOperations = [
    [retiredFactory, factoryInterface.encodeFunctionData("pauseLaunches"), "Retire previous launches"],
    [feeVault, vaultInterface.encodeFunctionData("setRegistrar", [retiredFactory, false]), "Revoke previous registrar"],
    [feeVault, vaultInterface.encodeFunctionData("setCollector", [retiredFactory, false]), "Revoke previous collector"],
    [feeVault, vaultInterface.encodeFunctionData("setRegistrar", [factoryAddress, true]), "Authorize new registrar"],
    [feeVault, vaultInterface.encodeFunctionData("setCollector", [factoryAddress, true]), "Authorize new collector"],
    [feeVault, vaultInterface.encodeFunctionData("setFeeRecipient", [protocolFeeRecipient]), "Set reviewed protocol recipient"],
    [creatorRegistry, registryInterface.encodeFunctionData("setFactory", [factoryAddress]), "Select new Factory"],
    [factoryAddress, factoryInterface.encodeFunctionData("unpauseLaunches"), "Activate reviewed launches"],
  ].map(([target, data, purpose]) => ({ target, value: "0", data, purpose }));

  const manifest = {
    network: "arc-mainnet",
    chainId: Number(ARC_MAINNET_CHAIN_ID),
    status: "MAINNET_CANDIDATE_PAUSED_REQUIRES_SAFE_ACTIVATION",
    contracts: {
      factory: factoryAddress,
      liquidityLocker: lockerAddress,
      feeVault,
      creatorRegistry,
      usdc: ARC_USDC,
      uniswapV3Factory: UNISWAP_V3_FACTORY,
      uniswapV3PositionManager: UNISWAP_V3_POSITION_MANAGER,
      uniswapV3SwapRouter: UNISWAP_V3_SWAP_ROUTER,
    },
    economics: {
      totalSupply: "1000000000",
      startMarketCapUsdc: 5_000,
      crossedMarketCapUsdc: 50_000,
      poolFee: 10_000,
      creatorFeeShareBps: 7_000,
      protocolFeeShareBps: 3_000,
      automaticBuyback: "OPT_IN_CREATOR_SHARE_BUYBACK_AND_BURN",
      buybackKeeperRewardBps: 50,
      buybackKeeperRewardCapUsdc: 1,
      lpCustody: "PERMANENT_LOCKER_NO_WITHDRAWAL_PATH",
    },
    governance: { safe: governanceSafe, threshold: "2-of-3", emergencyGuardian },
    deploymentTransaction: transactionHash,
    deploymentBlock: receipt.blockNumber,
    recoveredAt: new Date().toISOString(),
    transition: {
      retiredFactory,
      retiredFactoryWasPaused: state.retiredPaused,
      previousProtocolFeeRecipient: state.previousFeeRecipient,
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
      description: "Atomically retire previous launches, rotate shared ACLs, select the reviewed Factory, and activate direct Uniswap pools.",
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
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(safeBatchPath, `${JSON.stringify(safeBatch, null, 2)}\n`);
  console.log(`Recovered verified candidate manifest: ${outputPath}`);
  console.log(`Recovered unsigned Safe batch: ${safeBatchPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
