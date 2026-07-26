const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_TESTNET_CHAIN_ID = 5_042_002n;
const USDC_DECIMALS = 6n;
const TARGET_LAUNCH_FEE = 10n * 10n ** USDC_DECIMALS;
const deploymentPath = path.join(__dirname, "..", "deployment", "arc-testnet.json");

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

async function main() {
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("DEPLOYER_PRIVATE_KEY is required.");
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, ARC_TESTNET_CHAIN_ID);
  assertEqual("signer", signer.address, deployment.deployer);

  const factory = await hre.ethers.getContractAt("ArcForgeFactory", deployment.contracts.factory);
  assertEqual("factory owner", await factory.owner(), signer.address);
  const currentFee = await factory.launchFee();
  if (currentFee === TARGET_LAUNCH_FEE) {
    console.log(`Launch fee already equals 10 USDC on ${deployment.contracts.factory}.`);
    return;
  }

  const transaction = await factory.setLaunchFee(TARGET_LAUNCH_FEE);
  console.log(`Launch fee update submitted: ${transaction.hash}`);
  await transaction.wait();
  assertEqual("updated launch fee", await factory.launchFee(), TARGET_LAUNCH_FEE);
  console.log(`Launch fee updated from ${currentFee} to ${TARGET_LAUNCH_FEE} base units (10 USDC).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
