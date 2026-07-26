const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_TESTNET_CHAIN_ID = 5_042_002n;
const candidatePath = path.join(__dirname, "..", "deployment", "arcTestnet-v5.local.json");
const deploymentPath = path.join(__dirname, "..", "deployment", "arc-testnet.json");

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

async function main() {
  if (!fs.existsSync(candidatePath)) throw new Error(`V5 candidate manifest not found at ${candidatePath}.`);
  const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  const current = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  if (candidate.status !== "V5_CANDIDATE_DEPLOYED") {
    throw new Error(`Candidate status must be V5_CANDIDATE_DEPLOYED, received ${candidate.status}.`);
  }
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, ARC_TESTNET_CHAIN_ID);
  assertEqual("deployer", deployer.address, candidate.deployer);
  assertEqual("previous factory", current.contracts.factory, candidate.migration.previousFactory);

  const registry = await hre.ethers.getContractAt("ArcForgeCreatorRegistry", candidate.contracts.creatorRegistry);
  const factory = await hre.ethers.getContractAt("ArcForgeFactoryV5", candidate.contracts.factory);
  assertEqual("registry owner", await registry.owner(), deployer.address);
  assertEqual("registry current factory", await registry.factory(), candidate.migration.previousFactory);
  assertEqual("factory owner", await factory.owner(), deployer.address);
  assertEqual("factory launch fee", await factory.launchFee(), 10n * 10n ** 6n);
  assertEqual("migration disabled", await factory.dexMigrationAdapter(), hre.ethers.ZeroAddress);
  console.log(`V5 activation preflight passed for ${candidate.contracts.factory}.`);
  if (process.env.DEPLOY_PREFLIGHT_ONLY === "true") return;

  const transaction = await registry.setFactory(candidate.contracts.factory);
  console.log(`Registry activation submitted: ${transaction.hash}`);
  const receipt = await transaction.wait();
  assertEqual("activated registry factory", await registry.factory(), candidate.contracts.factory);
  candidate.status = "V5_ACTIVE";
  candidate.migration.registryActivationTx = transaction.hash;
  candidate.migration.registryActivationBlock = receipt.blockNumber;
  candidate.migration.activatedAt = new Date().toISOString();
  fs.writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  fs.writeFileSync(deploymentPath, `${JSON.stringify(candidate, null, 2)}\n`);
  console.log(`V5 Factory activated and production manifest updated: ${candidate.contracts.factory}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
