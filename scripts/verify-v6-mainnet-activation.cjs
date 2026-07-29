const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_MAINNET_CHAIN_ID = 5_042n;
const manifestPath = process.env.V6_MANIFEST
  ? path.resolve(process.env.V6_MANIFEST)
  : path.join(__dirname, "..", "deployment", "arc-mainnet-v6.local.json");
const outputPath = process.env.V6_ACTIVATION_VERIFICATION_OUTPUT
  ? path.resolve(process.env.V6_ACTIVATION_VERIFICATION_OUTPUT)
  : path.join(
    __dirname,
    "..",
    "deployment",
    "v6-mainnet-activation-verification.local.json",
  );
const factoryAbi = [
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function migrationPaused() view returns (bool)",
  "function currentMigrationConfigurationHash() view returns (bytes32)",
];

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

async function verifiedReceipt(envName) {
  const hash = process.env[envName]?.trim();
  if (!hash) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error(`${envName} is not a transaction hash.`);
  }
  const receipt = await hre.ethers.provider.getTransactionReceipt(hash);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${envName} is missing or unsuccessful.`);
  }
  return {
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    status: receipt.status,
  };
}

async function main() {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`V6 mainnet manifest not found at ${manifestPath}.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const phase = process.env.V6_ACTIVATION_PHASE?.trim().toLowerCase();
  if (phase !== "migrations" && phase !== "launches") {
    throw new Error("V6_ACTIVATION_PHASE must be migrations or launches.");
  }

  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, ARC_MAINNET_CHAIN_ID);
  const factory = new hre.ethers.Contract(
    manifest.contracts.factory,
    factoryAbi,
    hre.ethers.provider,
  );
  assertEqual("Factory owner", await factory.owner(), manifest.governance.safe);
  assertEqual(
    "migration configuration hash",
    await factory.currentMigrationConfigurationHash(),
    manifest.dexMigration.configurationHash,
  );

  const launchesPaused = await factory.paused();
  const migrationsPaused = await factory.migrationPaused();
  if (migrationsPaused) {
    throw new Error("Migrations are still paused.");
  }
  if (phase === "migrations" && !launchesPaused) {
    throw new Error(
      "Launches were unpaused before the migration-only verification completed.",
    );
  }
  if (phase === "launches" && launchesPaused) {
    throw new Error("Launches are still paused.");
  }

  const migrationTransaction = await verifiedReceipt(
    "V6_MIGRATION_ACTIVATION_TX_HASH",
  );
  const launchTransaction =
    phase === "launches"
      ? await verifiedReceipt("V6_LAUNCH_ACTIVATION_TX_HASH")
      : null;
  if (phase === "launches" && !launchTransaction) {
    throw new Error(
      "V6_LAUNCH_ACTIVATION_TX_HASH is required for launch activation verification.",
    );
  }

  const result = {
    verifiedAt: new Date().toISOString(),
    chainId: Number(network.chainId),
    phase,
    factory: manifest.contracts.factory,
    governanceSafe: manifest.governance.safe,
    state: {
      migrationsPaused,
      launchesPaused,
      migrationConfigurationHash: manifest.dexMigration.configurationHash,
    },
    migrationTransaction,
    launchTransaction,
    verified: true,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`Verification written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
