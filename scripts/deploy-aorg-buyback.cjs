const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_TESTNET_CHAIN_ID = 5_042_002n;
const EXPECTED_NAME = "ArcOrigin";
const EXPECTED_SYMBOL = "AORG";
const GOVERNANCE_DELAY_SECONDS = 48n * 60n * 60n;
const DEFAULT_MAX_CHUNK_USDC = 25n * 10n ** 6n;
const DEFAULT_EXECUTION_INTERVAL = 3_600;
const DEFAULT_MAX_SLIPPAGE_BPS = 300;
const manifestPath = path.join(__dirname, "..", "deployment", "arc-testnet.json");
const outputPath = path.join(__dirname, "..", "deployment", "aorg-buyback.local.json");

const factoryAbi = [
  "function getTokenInfo(address token) view returns ((address token,address curve,address creator,uint64 launchedAt,string metadataURI))",
];
const tokenAbi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function factory() view returns (address)",
];
const curveAbi = [
  "function token() view returns (address)",
  "function usdc() view returns (address)",
  "function virtualUsdcReserve() view returns (uint256)",
  "function migrationConfigurationHash() view returns (bytes32)",
];
const safeAbi = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];
const timelockAbi = [
  "function getMinDelay() view returns (uint256)",
];

function requiredAddress(name) {
  const value = process.env[name];
  if (!value || !hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
    throw new Error(`${name} must be an explicitly configured non-zero address.`);
  }
  return hre.ethers.getAddress(value);
}

function requiredInteger(name, fallback) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function sameAddress(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

async function requireContract(label, address) {
  if (await hre.ethers.provider.getCode(address) === "0x") {
    throw new Error(`${label} must contain deployed contract bytecode.`);
  }
}

async function requireTwoOfThreeSafe(label, address) {
  const safe = new hre.ethers.Contract(address, safeAbi, hre.ethers.provider);
  const [owners, threshold] = await Promise.all([
    safe.getOwners(),
    safe.getThreshold(),
  ]);
  if (owners.length !== 3 || threshold !== 2n) {
    throw new Error(`${label} must be the reviewed 2-of-3 Safe.`);
  }
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const tokenAddress = requiredAddress("AORG_TOKEN");
  const curveAddress = requiredAddress("AORG_CURVE");
  const owner = requiredAddress("BUYBACK_OWNER");
  const guardian = requiredAddress("BUYBACK_GUARDIAN");
  const operationsRecipient = requiredAddress("BUYBACK_OPERATIONS_RECIPIENT");
  const executor = requiredAddress("BUYBACK_EXECUTOR");
  const maxChunkUsdc = BigInt(
    process.env.BUYBACK_MAX_CHUNK_USDC_RAW ?? DEFAULT_MAX_CHUNK_USDC,
  );
  const executionInterval = requiredInteger(
    "BUYBACK_EXECUTION_INTERVAL_SECONDS",
    DEFAULT_EXECUTION_INTERVAL,
  );
  const maxSlippageBps = requiredInteger(
    "BUYBACK_MAX_SLIPPAGE_BPS",
    DEFAULT_MAX_SLIPPAGE_BPS,
  );

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is required.");
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, ARC_TESTNET_CHAIN_ID);
  assertEqual("manifest chain ID", manifest.chainId, ARC_TESTNET_CHAIN_ID);

  for (const [label, address] of [
    ["Factory", manifest.contracts.factory],
    ["USDC", manifest.contracts.usdc],
    ["AORG token", tokenAddress],
    ["AORG curve", curveAddress],
    ["buyback owner", owner],
    ["buyback guardian", guardian],
    ["operations recipient", operationsRecipient],
  ]) {
    await requireContract(label, address);
  }
  if (sameAddress(operationsRecipient, owner)) {
    console.warn("Operations recipient and controller owner are the same contract.");
  }
  assertEqual("guardian Safe", guardian, manifest.emergencyGuardian);
  assertEqual("operations Safe", operationsRecipient, manifest.feeRecipient);
  await requireTwoOfThreeSafe("Guardian/operations recipient", operationsRecipient);
  const timelock = new hre.ethers.Contract(owner, timelockAbi, hre.ethers.provider);
  if (await timelock.getMinDelay() < GOVERNANCE_DELAY_SECONDS) {
    throw new Error("BUYBACK_OWNER must enforce a governance delay of at least 48 hours.");
  }

  const factory = new hre.ethers.Contract(
    manifest.contracts.factory,
    factoryAbi,
    hre.ethers.provider,
  );
  const token = new hre.ethers.Contract(tokenAddress, tokenAbi, hre.ethers.provider);
  const curve = new hre.ethers.Contract(curveAddress, curveAbi, hre.ethers.provider);
  const launch = await factory.getTokenInfo(tokenAddress);
  const [name, symbol, tokenFactory, curveToken, curveUsdc, virtualReserve, migrationHash] =
    await Promise.all([
      token.name(),
      token.symbol(),
      token.factory(),
      curve.token(),
      curve.usdc(),
      curve.virtualUsdcReserve(),
      curve.migrationConfigurationHash(),
    ]);

  assertEqual("AORG name", name, EXPECTED_NAME);
  assertEqual("AORG symbol", symbol, EXPECTED_SYMBOL);
  assertEqual("token factory", tokenFactory, manifest.contracts.factory);
  assertEqual("Factory launch token", launch.token, tokenAddress);
  assertEqual("Factory launch curve", launch.curve, curveAddress);
  assertEqual("AORG creator Safe", launch.creator, manifest.feeRecipient);
  assertEqual("curve token", curveToken, tokenAddress);
  assertEqual("curve USDC", curveUsdc, manifest.contracts.usdc);
  assertEqual("curve migration configuration", migrationHash, hre.ethers.ZeroHash);
  assertEqual(
    "maximum TWAP chunk",
    maxChunkUsdc <= virtualReserve / 100n,
    true,
  );
  if (executionInterval < 300 || executionInterval > 30 * 24 * 60 * 60) {
    throw new Error("BUYBACK_EXECUTION_INTERVAL_SECONDS must be between 300 and 2592000.");
  }
  if (maxSlippageBps > 500) {
    throw new Error("BUYBACK_MAX_SLIPPAGE_BPS cannot exceed 500.");
  }
  if (fs.existsSync(outputPath) && process.env.DEPLOY_PREFLIGHT_ONLY !== "true") {
    throw new Error(`Refusing to overwrite existing deployment record at ${outputPath}.`);
  }

  console.log(`AORG launch verified: ${name} (${symbol})`);
  console.log(`AORG token: ${tokenAddress}`);
  console.log(`AORG curve: ${curveAddress}`);
  console.log(`Controller owner: ${owner}`);
  console.log(`Operations recipient: ${operationsRecipient}`);
  console.log(`Initial executor: ${executor}`);
  console.log(`TWAP: ${maxChunkUsdc} raw USDC every ${executionInterval}s, ${maxSlippageBps} bps max slippage`);
  if (process.env.DEPLOY_PREFLIGHT_ONLY === "true") {
    console.log("Buyback deployment preflight passed; no transaction sent.");
    return;
  }

  const Controller = await hre.ethers.getContractFactory("ArcOriginBuybackController");
  const controller = await Controller.deploy(
    owner,
    guardian,
    operationsRecipient,
    executor,
    manifest.contracts.usdc,
    tokenAddress,
    curveAddress,
    maxChunkUsdc,
    executionInterval,
    maxSlippageBps,
  );
  const deploymentTransaction = controller.deploymentTransaction();
  console.log(`Buyback controller submitted: ${deploymentTransaction.hash}`);
  const receipt = await deploymentTransaction.wait();
  if (receipt.status !== 1) throw new Error("Buyback controller deployment reverted.");
  await controller.waitForDeployment();
  const controllerAddress = await controller.getAddress();

  const checks = [
    ["owner", await controller.owner(), owner],
    ["guardian", await controller.emergencyGuardian(), guardian],
    ["operations recipient", await controller.operationsRecipient(), operationsRecipient],
    ["executor", await controller.isExecutor(executor), true],
    ["USDC", await controller.usdc(), manifest.contracts.usdc],
    ["AORG", await controller.protocolToken(), tokenAddress],
    ["curve", await controller.curve(), curveAddress],
    ["buyback share", await controller.BUYBACK_SHARE_BPS(), 8_000n],
    ["max chunk", await controller.maxChunkUsdc(), maxChunkUsdc],
    ["execution interval", await controller.executionInterval(), BigInt(executionInterval)],
    ["max slippage", await controller.maxSlippageBps(), BigInt(maxSlippageBps)],
  ];
  for (const [label, actual, expected] of checks) {
    assertEqual(label, actual, expected);
  }

  const feeVaultInterface = new hre.ethers.Interface([
    "function setFeeRecipient(address newRecipient)",
  ]);
  const deployment = {
    network: manifest.network,
    chainId: manifest.chainId,
    controller: controllerAddress,
    token: tokenAddress,
    curve: curveAddress,
    usdc: manifest.contracts.usdc,
    feeVault: manifest.contracts.feeVault,
    owner,
    emergencyGuardian: guardian,
    operationsRecipient,
    executor,
    config: {
      buybackShareBps: 8_000,
      operationsShareBps: 2_000,
      maxChunkUsdcRaw: maxChunkUsdc.toString(),
      executionIntervalSeconds: executionInterval,
      maxSlippageBps,
      burnAddress: await controller.BURN_ADDRESS(),
    },
    deploymentTransaction: deploymentTransaction.hash,
    deploymentBlock: receipt.blockNumber,
    deployedAt: new Date().toISOString(),
    status: "DEPLOYED_REQUIRES_TIMELOCKED_FEE_RECIPIENT_UPDATE",
    governanceAction: {
      target: manifest.contracts.feeVault,
      value: "0",
      calldata: feeVaultInterface.encodeFunctionData("setFeeRecipient", [controllerAddress]),
      description: "Route future authorized FeeVault withdrawals through the immutable 80/20 AORG controller",
    },
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`Buyback controller deployed: ${controllerAddress}`);
  console.log(`Local deployment and governance calldata: ${outputPath}`);
  console.log("The FeeVault recipient has NOT been changed. Review and schedule the emitted governance action.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
