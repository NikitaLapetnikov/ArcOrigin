const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_MAINNET_CHAIN_ID = 5_042n;
const manifestPath = process.env.MAINNET_DEPLOYMENT_MANIFEST
  ? path.resolve(process.env.MAINNET_DEPLOYMENT_MANIFEST)
  : path.join(__dirname, "..", "deployment", "arc-mainnet.local.json");

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
  if (!process.env.ARC_MAINNET_RPC_URL?.trim()) {
    throw new Error("ARC_MAINNET_RPC_URL must be explicitly configured.");
  }
  if (!fs.existsSync(manifestPath)) throw new Error(`Manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const provider = hre.ethers.provider;
  const network = await retry("network read", () => provider.getNetwork());
  assertEqual("chain ID", network.chainId, ARC_MAINNET_CHAIN_ID);
  assertEqual("manifest chain ID", manifest.chainId, ARC_MAINNET_CHAIN_ID);

  const transaction = await retry("deployment transaction read", () =>
    provider.getTransaction(manifest.deploymentTransaction));
  const receipt = await retry("deployment receipt read", () =>
    provider.getTransactionReceipt(manifest.deploymentTransaction));
  if (!transaction || !receipt || receipt.status !== 1 || !receipt.contractAddress) {
    throw new Error("Deployment transaction is missing or unsuccessful.");
  }
  assertEqual("created Factory", receipt.contractAddress, manifest.contracts.factory);

  const artifact = await hre.artifacts.readArtifact("ArcForgeFactory");
  const factory = new hre.ethers.ContractFactory(artifact.abi, artifact.bytecode);
  const expectedDeployment = await factory.getDeployTransaction(
    manifest.governance.safe,
    manifest.governance.emergencyGuardian,
    manifest.contracts.usdc,
    manifest.contracts.feeVault,
    manifest.contracts.creatorRegistry,
    manifest.contracts.uniswapV3Factory,
    manifest.contracts.uniswapV3PositionManager,
    10n * 10n ** 6n,
  );
  assertEqual("audited creation bytecode and constructor args", transaction.data, expectedDeployment.data);

  const [factoryRuntime, lockerRuntime] = await Promise.all([
    retry("Factory runtime read", () => provider.getCode(manifest.contracts.factory)),
    retry("Locker runtime read", () => provider.getCode(manifest.contracts.liquidityLocker)),
  ]);
  if (factoryRuntime === "0x" || lockerRuntime === "0x") {
    throw new Error("Factory or Locker runtime bytecode is missing.");
  }

  console.log(JSON.stringify({
    reproducibleBuildVerified: true,
    checkedAt: new Date().toISOString(),
    chainId: Number(network.chainId),
    deploymentTransaction: transaction.hash,
    deploymentBlock: receipt.blockNumber,
    factory: manifest.contracts.factory,
    liquidityLocker: manifest.contracts.liquidityLocker,
    creationInputHash: hre.ethers.keccak256(transaction.data),
    factoryRuntimeHash: hre.ethers.keccak256(factoryRuntime),
    lockerRuntimeHash: hre.ethers.keccak256(lockerRuntime),
    compiler: "0.8.24",
    optimizerRuns: 500,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
