const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_MAINNET_CHAIN_ID = 5_042n;
const ZERO_ADDRESS = hre.ethers.ZeroAddress;
const manifestPath = process.env.V6_MANIFEST
  ? path.resolve(process.env.V6_MANIFEST)
  : path.join(__dirname, "..", "deployment", "arc-mainnet-v6.local.json");
const governancePath = process.env.MAINNET_GOVERNANCE_MANIFEST
  ? path.resolve(process.env.MAINNET_GOVERNANCE_MANIFEST)
  : path.join(__dirname, "..", "deployment", "governance-5042.local.json");
const migrationBatchPath = process.env.V6_MIGRATION_ACTIVATION_BATCH
  ? path.resolve(process.env.V6_MIGRATION_ACTIVATION_BATCH)
  : path.join(
    __dirname,
    "..",
    "deployment",
    "v6-mainnet-unpause-migrations.safe.local.json",
  );
const launchesBatchPath = process.env.V6_LAUNCH_ACTIVATION_BATCH
  ? path.resolve(process.env.V6_LAUNCH_ACTIVATION_BATCH)
  : path.join(
    __dirname,
    "..",
    "deployment",
    "v6-mainnet-unpause-launches.safe.local.json",
  );
const reportPath = process.env.V6_ACTIVATION_PREPARATION_OUTPUT
  ? path.resolve(process.env.V6_ACTIVATION_PREPARATION_OUTPUT)
  : path.join(
    __dirname,
    "..",
    "deployment",
    "v6-mainnet-activation-preparation.local.json",
  );

const factoryAbi = [
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function migrationPaused() view returns (bool)",
  "function dexMigrationAdapter() view returns (address)",
  "function liquidityLocker() view returns (address)",
  "function migrationVerifier() view returns (address)",
  "function currentMigrationConfigurationHash() view returns (bytes32)",
  "function unpauseMigrations()",
  "function unpauseLaunches()",
];
const safeAbi = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];

function sameAddress(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function assertEqual(label, actual, expected) {
  if (!sameAddress(actual, expected)) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}.`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function requireContract(label, address) {
  if (
    !hre.ethers.isAddress(address) ||
    sameAddress(address, ZERO_ADDRESS) ||
    (await hre.ethers.provider.getCode(address)) === "0x"
  ) {
    throw new Error(`${label} has no deployed contract at ${address}.`);
  }
}

function safeBatch({ chainId, safe, name, description, transaction }) {
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: {
      name,
      description,
      createdFromSafeAddress: safe,
    },
    transactions: [transaction],
  };
}

function safeTransaction(to, data) {
  return {
    to,
    value: "0",
    data,
    contractMethod: null,
    contractInputsValues: null,
  };
}

async function main() {
  const manifest = readJson(manifestPath, "V6 mainnet manifest");
  const governance = readJson(governancePath, "Mainnet governance manifest");
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, ARC_MAINNET_CHAIN_ID);
  assertEqual("manifest chain ID", manifest.chainId, ARC_MAINNET_CHAIN_ID);
  assertEqual("governance chain ID", governance.chainId, ARC_MAINNET_CHAIN_ID);

  if (
    manifest.governance?.mode !== "DIRECT_SAFE_2_OF_3" ||
    manifest.governance?.handoffComplete !== true ||
    manifest.governanceHandoffComplete !== true
  ) {
    throw new Error("V6 direct-Safe ownership handoff is not recorded as complete.");
  }
  if (
    governance.ownershipMode !== "DIRECT_SAFE_2_OF_3" ||
    governance.ownershipTransferred !== true ||
    governance.ownershipPending !== false
  ) {
    throw new Error("Governance manifest does not record a completed direct-Safe handoff.");
  }

  const factoryAddress = hre.ethers.getAddress(manifest.contracts.factory);
  const governanceSafe = hre.ethers.getAddress(manifest.governance.safe);
  assertEqual("governance Safe", governance.governanceSafe, governanceSafe);
  await Promise.all([
    requireContract("V6 Factory", factoryAddress),
    requireContract("Governance Safe", governanceSafe),
  ]);

  const safe = new hre.ethers.Contract(governanceSafe, safeAbi, hre.ethers.provider);
  const [safeOwners, safeThreshold] = await Promise.all([
    safe.getOwners(),
    safe.getThreshold(),
  ]);
  if (safeThreshold !== 2n || safeOwners.length !== 3) {
    throw new Error("Governance Safe is not exactly 2-of-3.");
  }
  const expectedOwners = governance.safeOwners ?? [];
  const actualOwnerSet = new Set(safeOwners.map((owner) => owner.toLowerCase()));
  if (
    expectedOwners.length !== 3 ||
    new Set(expectedOwners.map((owner) => owner.toLowerCase())).size !== 3 ||
    expectedOwners.some((owner) => !actualOwnerSet.has(owner.toLowerCase()))
  ) {
    throw new Error("Governance Safe owners do not match the reviewed manifest.");
  }

  const factory = new hre.ethers.Contract(
    factoryAddress,
    factoryAbi,
    hre.ethers.provider,
  );
  assertEqual("Factory owner", await factory.owner(), governanceSafe);
  if (!(await factory.paused())) {
    throw new Error("Launches are already unpaused; refusing to prepare a stale batch.");
  }
  if (!(await factory.migrationPaused())) {
    throw new Error("Migrations are already unpaused; refusing to prepare a stale batch.");
  }

  const migration = manifest.dexMigration;
  if (
    !migration?.configured ||
    migration?.paused !== true ||
    migration?.enabled !== false
  ) {
    throw new Error("Manifest does not describe a configured, paused migration path.");
  }
  assertEqual(
    "migration adapter",
    await factory.dexMigrationAdapter(),
    migration.adapter,
  );
  assertEqual(
    "liquidity locker",
    await factory.liquidityLocker(),
    migration.locker,
  );
  assertEqual(
    "migration verifier",
    await factory.migrationVerifier(),
    migration.verifier,
  );
  assertEqual(
    "migration configuration hash",
    await factory.currentMigrationConfigurationHash(),
    migration.configurationHash,
  );

  const migrationTransaction = safeTransaction(
    factoryAddress,
    factory.interface.encodeFunctionData("unpauseMigrations"),
  );
  const launchesTransaction = safeTransaction(
    factoryAddress,
    factory.interface.encodeFunctionData("unpauseLaunches"),
  );
  const migrationBatch = safeBatch({
    chainId: network.chainId,
    safe: governanceSafe,
    name: "ArcOrigin V6 — enable verified migrations",
    description:
      "Phase 1 of 2. Unpause the reviewed V6 migration configuration. Execute and verify this transaction before importing the launch activation batch.",
    transaction: migrationTransaction,
  });
  const launchesBatch = safeBatch({
    chainId: network.chainId,
    safe: governanceSafe,
    name: "ArcOrigin V6 — enable token launches",
    description:
      "Phase 2 of 2. Unpause V6 token launches only after the migration activation transaction is final and independently verified.",
    transaction: launchesTransaction,
  });
  const blockNumber = await hre.ethers.provider.getBlockNumber();
  const report = {
    preparedAt: new Date().toISOString(),
    preparedAtBlock: blockNumber,
    chainId: Number(network.chainId),
    factory: factoryAddress,
    governanceSafe,
    safeOwners,
    safeThreshold: Number(safeThreshold),
    initialState: {
      launchesPaused: true,
      migrationsPaused: true,
      migrationConfigurationHash: migration.configurationHash,
    },
    order: [
      {
        phase: 1,
        action: "unpauseMigrations",
        batch: migrationBatchPath,
        transaction: migrationTransaction,
      },
      {
        phase: 2,
        action: "unpauseLaunches",
        batch: launchesBatchPath,
        prerequisite:
          "Phase 1 final, migrationsPaused=false verified onchain, production release gates complete.",
        transaction: launchesTransaction,
      },
    ],
    sendsTransactions: false,
  };

  fs.writeFileSync(migrationBatchPath, `${JSON.stringify(migrationBatch, null, 2)}\n`);
  fs.writeFileSync(launchesBatchPath, `${JSON.stringify(launchesBatch, null, 2)}\n`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`Governance Safe: ${governanceSafe}`);
  console.log(`Factory: ${factoryAddress}`);
  console.log(`Migration batch: ${migrationBatchPath}`);
  console.log(`Launch batch: ${launchesBatchPath}`);
  console.log(`Preparation report: ${reportPath}`);
  console.log("No transaction was sent.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
