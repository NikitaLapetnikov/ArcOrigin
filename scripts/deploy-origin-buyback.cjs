const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_MAINNET_CHAIN_ID = 5_042n;
const TOKEN = "0xB65Fd34cc428492DdF000A2Ae100Dbfea62E4802";
const CURVE = "0x18708Bd06e264E8147065159C90460be4b5B5312";
const EXPECTED_NAME = "ArcOrigin";
const EXPECTED_SYMBOL = "ORIGIN";
const DEFAULT_MAX_CHUNK_USDC = 25n * 10n ** 6n;
const DEFAULT_EXECUTION_INTERVAL = 3_600;
const DEFAULT_MAX_SLIPPAGE_BPS = 300;
const manifestPath = path.join(__dirname, "..", "deployment", "arc-mainnet-v6.local.json");
const outputPath = path.join(__dirname, "..", "deployment", "origin-buyback-mainnet.local.json");

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
  "function isMigrated() view returns (bool)",
];
const safeAbi = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];
const ownableAbi = ["function owner() view returns (address)"];

function sameAddress(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

async function requireContract(label, address) {
  if (!hre.ethers.isAddress(address) || await hre.ethers.provider.getCode(address) === "0x") {
    throw new Error(`${label} must be a deployed non-zero contract.`);
  }
}

async function requireTwoOfThreeSafe(label, address) {
  const safe = new hre.ethers.Contract(address, safeAbi, hre.ethers.provider);
  const [owners, threshold] = await Promise.all([safe.getOwners(), safe.getThreshold()]);
  if (owners.length !== 3 || threshold !== 2n) {
    throw new Error(`${label} must be the reviewed 2-of-3 Safe.`);
  }
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("MAINNET_DEPLOYER_PRIVATE_KEY is required.");

  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, ARC_MAINNET_CHAIN_ID);
  assertEqual("manifest chain ID", manifest.chainId, ARC_MAINNET_CHAIN_ID);

  const governanceSafe = hre.ethers.getAddress(manifest.governance.safe);
  const executor = hre.ethers.getAddress(
    process.env.BUYBACK_EXECUTOR || deployer.address,
  );
  const maxChunkUsdc = BigInt(
    process.env.BUYBACK_MAX_CHUNK_USDC_RAW || DEFAULT_MAX_CHUNK_USDC,
  );
  const executionInterval = Number(
    process.env.BUYBACK_EXECUTION_INTERVAL_SECONDS || DEFAULT_EXECUTION_INTERVAL,
  );
  const maxSlippageBps = Number(
    process.env.BUYBACK_MAX_SLIPPAGE_BPS || DEFAULT_MAX_SLIPPAGE_BPS,
  );

  for (const [label, address] of [
    ["Factory", manifest.contracts.factory],
    ["FeeVault", manifest.contracts.feeVault],
    ["USDC", manifest.contracts.usdc],
    ["ORIGIN token", TOKEN],
    ["ORIGIN curve", CURVE],
    ["Governance Safe", governanceSafe],
  ]) {
    await requireContract(label, address);
  }
  if (executor === hre.ethers.ZeroAddress) throw new Error("Executor cannot be the zero address.");
  await requireTwoOfThreeSafe("Governance Safe", governanceSafe);
  if (!sameAddress(manifest.feeRecipient, governanceSafe)) {
    throw new Error("Reviewed FeeVault recipient must still be the Governance Safe.");
  }
  if (!manifest.dexMigration?.enabled || manifest.dexMigration?.paused) {
    throw new Error("Reviewed mainnet migration configuration is not active.");
  }

  const factory = new hre.ethers.Contract(
    manifest.contracts.factory,
    factoryAbi,
    hre.ethers.provider,
  );
  const token = new hre.ethers.Contract(TOKEN, tokenAbi, hre.ethers.provider);
  const curve = new hre.ethers.Contract(CURVE, curveAbi, hre.ethers.provider);
  const vault = new hre.ethers.Contract(
    manifest.contracts.feeVault,
    ownableAbi,
    hre.ethers.provider,
  );
  const launch = await factory.getTokenInfo(TOKEN);
  const [name, symbol, tokenFactory, curveToken, curveUsdc, virtualReserve, migrationHash, migrated] =
    await Promise.all([
      token.name(),
      token.symbol(),
      token.factory(),
      curve.token(),
      curve.usdc(),
      curve.virtualUsdcReserve(),
      curve.migrationConfigurationHash(),
      curve.isMigrated(),
    ]);

  assertEqual("ORIGIN name", name, EXPECTED_NAME);
  assertEqual("ORIGIN symbol", symbol, EXPECTED_SYMBOL);
  assertEqual("token factory", tokenFactory, manifest.contracts.factory);
  assertEqual("Factory launch token", launch.token, TOKEN);
  assertEqual("Factory launch curve", launch.curve, CURVE);
  assertEqual("ORIGIN creator", launch.creator, manifest.deployer);
  assertEqual("curve token", curveToken, TOKEN);
  assertEqual("curve USDC", curveUsdc, manifest.contracts.usdc);
  assertEqual("curve migration configuration", migrationHash, manifest.dexMigration.configurationHash);
  assertEqual("FeeVault owner", await vault.owner(), governanceSafe);
  if (migrated) throw new Error("ORIGIN has already migrated; curve buyback deployment is no longer valid.");
  if (maxChunkUsdc === 0n || maxChunkUsdc > virtualReserve / 100n) {
    throw new Error("Buyback chunk must be non-zero and no more than 1% of virtual USDC reserve.");
  }
  if (!Number.isSafeInteger(executionInterval) || executionInterval < 300 || executionInterval > 2_592_000) {
    throw new Error("Execution interval must be between 300 and 2592000 seconds.");
  }
  if (!Number.isSafeInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > 500) {
    throw new Error("Maximum slippage must be between 0 and 500 bps.");
  }
  if (fs.existsSync(outputPath) && process.env.DEPLOY_PREFLIGHT_ONLY !== "true") {
    throw new Error(`Refusing to overwrite deployment record at ${outputPath}.`);
  }

  console.log(`ORIGIN launch verified: ${name} (${symbol})`);
  console.log(`Token: ${TOKEN}`);
  console.log(`Curve: ${CURVE}`);
  console.log(`Controller owner/guardian/operations recipient: ${governanceSafe}`);
  console.log(`Executor: ${executor}`);
  console.log(`TWAP: ${maxChunkUsdc} raw USDC every ${executionInterval}s, ${maxSlippageBps} bps max slippage`);
  if (process.env.DEPLOY_PREFLIGHT_ONLY === "true") {
    console.log("ORIGIN buyback preflight passed; no transaction sent.");
    return;
  }

  const Controller = await hre.ethers.getContractFactory("ArcOriginBuybackController");
  const controller = await Controller.deploy(
    governanceSafe,
    governanceSafe,
    governanceSafe,
    executor,
    manifest.contracts.usdc,
    TOKEN,
    CURVE,
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

  const feeVaultInterface = new hre.ethers.Interface([
    "function setFeeRecipient(address newRecipient)",
  ]);
  const deployment = {
    network: manifest.network,
    chainId: manifest.chainId,
    controller: controllerAddress,
    token: TOKEN,
    curve: CURVE,
    usdc: manifest.contracts.usdc,
    feeVault: manifest.contracts.feeVault,
    owner: governanceSafe,
    emergencyGuardian: governanceSafe,
    operationsRecipient: governanceSafe,
    executor,
    config: {
      buybackShareBps: 8_000,
      operationsShareBps: 2_000,
      maxChunkUsdcRaw: maxChunkUsdc.toString(),
      executionIntervalSeconds: executionInterval,
      maxSlippageBps,
      burnAddress: await controller.BURN_ADDRESS(),
      executionVenue: "ORIGIN_V6_CURVE_UNTIL_MIGRATION",
    },
    deploymentTransaction: deploymentTransaction.hash,
    deploymentBlock: receipt.blockNumber,
    deployedAt: new Date().toISOString(),
    status: "DEPLOYED_REQUIRES_SAFE_FEE_RECIPIENT_UPDATE",
    governanceAction: {
      target: manifest.contracts.feeVault,
      value: "0",
      calldata: feeVaultInterface.encodeFunctionData("setFeeRecipient", [controllerAddress]),
      description: "Route future FeeVault withdrawals through the immutable 80/20 ORIGIN controller",
    },
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(deployment, null, 2)}\n`);
  console.log(`Buyback controller deployed: ${controllerAddress}`);
  console.log(`Safe activation calldata written to: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
