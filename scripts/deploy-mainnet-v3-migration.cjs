const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_MAINNET_CHAIN_ID = 5_042n;
const ARC_USDC_PREDEPLOY = "0x3600000000000000000000000000000000000000";
const OFFICIAL_V3_FACTORY = "0xf0db7b58379503491d857db50ac9ece64c653918";
const OFFICIAL_V3_POSITION_MANAGER =
  "0x39654a85a4c05127f5fd6ed22caec077a0fb1377";
const OFFICIAL_V3_QUOTER = "0x7dfd4f31be6814d2906bde155c3e1b146eac1468";
const OFFICIAL_V3_SWAP_ROUTER =
  "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77";
const POOL_FEE = 10_000n;
const outputPath = path.join(
  __dirname,
  "..",
  "deployment",
  "arc-mainnet-v3-migration.local.json",
);

const factoryAbi = [
  "function usdc() view returns (address)",
  "function feeVault() view returns (address)",
  "function paused() view returns (bool)",
  "function migrationPaused() view returns (bool)",
  "function dexMigrationAdapter() view returns (address)",
];
const positionManagerAbi = ["function factory() view returns (address)"];
const uniswapFactoryAbi = [
  "function feeAmountTickSpacing(uint24 fee) view returns (int24)",
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

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

async function requireContract(label, address) {
  const code = await hre.ethers.provider.getCode(address);
  if (code === "0x") {
    throw new Error(`${label} has no deployed bytecode at ${address}.`);
  }
  return code;
}

async function deploy(contractName, constructorArguments, label) {
  const Contract = await hre.ethers.getContractFactory(contractName);
  const contract = await Contract.deploy(...constructorArguments);
  const transaction = contract.deploymentTransaction();
  console.log(`${label}: ${transaction.hash}`);
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${label} reverted.`);
  await contract.waitForDeployment();
  return {
    contract,
    address: await contract.getAddress(),
    transactionHash: transaction.hash,
    blockNumber: receipt.blockNumber,
  };
}

async function runtimeCodeHash(address) {
  return hre.ethers.keccak256(await requireContract("deployed contract", address));
}

async function main() {
  requiredValue("ARC_MAINNET_RPC_URL");
  const expectedDeployer = requiredAddress("MAINNET_EXPECTED_DEPLOYER");
  const factoryAddress = requiredAddress("NEXT_PUBLIC_MAINNET_FACTORY_ADDRESS");
  const vaultAddress = requiredAddress("NEXT_PUBLIC_MAINNET_FEE_VAULT_ADDRESS");
  const configuredV3Factory = requiredAddress("UNISWAP_V3_FACTORY");
  const configuredPositionManager = requiredAddress(
    "UNISWAP_V3_POSITION_MANAGER",
  );
  const configuredQuoter = requiredAddress("UNISWAP_V3_QUOTER");
  const configuredSwapRouter = requiredAddress("UNISWAP_V3_SWAP_ROUTER");
  assertEqual("official Arc V3 Factory", configuredV3Factory, OFFICIAL_V3_FACTORY);
  assertEqual(
    "official Arc V3 PositionManager",
    configuredPositionManager,
    OFFICIAL_V3_POSITION_MANAGER,
  );
  assertEqual("official Arc V3 Quoter", configuredQuoter, OFFICIAL_V3_QUOTER);
  assertEqual(
    "official Arc V3 SwapRouter02",
    configuredSwapRouter,
    OFFICIAL_V3_SWAP_ROUTER,
  );

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("MAINNET_DEPLOYER_PRIVATE_KEY is required.");
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, ARC_MAINNET_CHAIN_ID);
  assertEqual("deployer", deployer.address, expectedDeployer);
  await Promise.all([
    requireContract("Factory V6", factoryAddress),
    requireContract("FeeVault V6", vaultAddress),
    requireContract("canonical Arc USDC", ARC_USDC_PREDEPLOY),
    requireContract("Uniswap V3 Factory", configuredV3Factory),
    requireContract("Uniswap V3 PositionManager", configuredPositionManager),
    requireContract("Uniswap V3 Quoter", configuredQuoter),
    requireContract("Uniswap V3 SwapRouter02", configuredSwapRouter),
  ]);
  if (fs.existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite ${outputPath}. Archive it first.`);
  }

  const factory = new hre.ethers.Contract(
    factoryAddress,
    factoryAbi,
    hre.ethers.provider,
  );
  const positionManager = new hre.ethers.Contract(
    configuredPositionManager,
    positionManagerAbi,
    hre.ethers.provider,
  );
  const uniswapFactory = new hre.ethers.Contract(
    configuredV3Factory,
    uniswapFactoryAbi,
    hre.ethers.provider,
  );
  assertEqual("Factory USDC", await factory.usdc(), ARC_USDC_PREDEPLOY);
  assertEqual("Factory FeeVault", await factory.feeVault(), vaultAddress);
  assertEqual("Factory launches paused", await factory.paused(), true);
  assertEqual("Factory migrations paused", await factory.migrationPaused(), true);
  assertEqual(
    "Factory migration unconfigured",
    await factory.dexMigrationAdapter(),
    hre.ethers.ZeroAddress,
  );
  assertEqual(
    "PositionManager Factory",
    await positionManager.factory(),
    configuredV3Factory,
  );
  if ((await uniswapFactory.feeAmountTickSpacing(POOL_FEE)) <= 0n) {
    throw new Error("Uniswap V3 1% fee tier is not enabled.");
  }
  if ((await hre.ethers.provider.getBalance(deployer.address)) === 0n) {
    throw new Error("The deployer has no Arc USDC for gas.");
  }

  const adapterDeployment = await deploy(
    "ArcOriginUniswapV3MigrationAdapter",
    [
      factoryAddress,
      configuredV3Factory,
      configuredPositionManager,
      ARC_USDC_PREDEPLOY,
    ],
    "ArcOrigin V3 MigrationAdapter",
  );
  const lockerDeployment = await deploy(
    "ArcOriginUniswapV3LiquidityLocker",
    [
      adapterDeployment.address,
      configuredPositionManager,
      vaultAddress,
    ],
    "ArcOrigin permanent V3 LiquidityLocker",
  );
  const verifierDeployment = await deploy(
    "ArcOriginUniswapV3MigrationVerifier",
    [
      factoryAddress,
      configuredV3Factory,
      configuredPositionManager,
      ARC_USDC_PREDEPLOY,
      adapterDeployment.address,
      lockerDeployment.address,
    ],
    "ArcOrigin V3 MigrationVerifier",
  );

  assertEqual(
    "adapter controller",
    await adapterDeployment.contract.migrationController(),
    factoryAddress,
  );
  assertEqual(
    "adapter locker binding",
    await lockerDeployment.contract.adapter(),
    adapterDeployment.address,
  );
  assertEqual(
    "locker protocol recipient",
    await lockerDeployment.contract.protocolFeeRecipient(),
    vaultAddress,
  );
  assertEqual(
    "verifier adapter binding",
    await verifierDeployment.contract.adapter(),
    adapterDeployment.address,
  );
  assertEqual(
    "verifier locker binding",
    await verifierDeployment.contract.locker(),
    lockerDeployment.address,
  );

  const manifest = {
    network: "arc-mainnet",
    chainId: Number(ARC_MAINNET_CHAIN_ID),
    protocolFactory: factoryAddress,
    quoteToken: ARC_USDC_PREDEPLOY,
    uniswap: {
      version: "v3",
      factory: configuredV3Factory,
      positionManager: configuredPositionManager,
      quoter: configuredQuoter,
      swapRouter: configuredSwapRouter,
      fee: Number(POOL_FEE),
    },
    contracts: {
      adapter: adapterDeployment.address,
      locker: lockerDeployment.address,
      verifier: verifierDeployment.address,
    },
    runtimeCodeHashes: {
      adapter: await runtimeCodeHash(adapterDeployment.address),
      locker: await runtimeCodeHash(lockerDeployment.address),
      verifier: await runtimeCodeHash(verifierDeployment.address),
      uniswapFactory: await runtimeCodeHash(configuredV3Factory),
      uniswapPositionManager: await runtimeCodeHash(configuredPositionManager),
      uniswapQuoter: await runtimeCodeHash(configuredQuoter),
      uniswapSwapRouter: await runtimeCodeHash(configuredSwapRouter),
    },
    deploymentTransactions: {
      adapter: adapterDeployment.transactionHash,
      locker: lockerDeployment.transactionHash,
      verifier: verifierDeployment.transactionHash,
    },
    deploymentBlocks: {
      adapter: adapterDeployment.blockNumber,
      locker: lockerDeployment.blockNumber,
      verifier: verifierDeployment.blockNumber,
    },
    configuredInFactory: false,
    migrationEnabled: false,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
  console.log(`Manifest written to ${outputPath}`);
  console.log(
    "STOP: this script does not configure Factory or enable migration. Verify source, reproduce code hashes, rehearse on a fork, then use Timelock operations.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
