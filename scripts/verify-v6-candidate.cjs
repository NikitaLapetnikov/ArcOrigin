const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_CHAIN_ID = 5_042_002n;
const EXPECTED_USDC = "0x3600000000000000000000000000000000000000";
const EXPECTED_LAUNCH_FEE = 10n * 10n ** 6n;
const candidatePath = process.env.V6_MANIFEST
  ? path.resolve(process.env.V6_MANIFEST)
  : path.join(__dirname, "..", "deployment", "arcTestnet-v6.local.json");

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

function zeroRange(hex, start, length) {
  const offset = 2 + start * 2;
  return `${hex.slice(0, offset)}${"0".repeat(length * 2)}${hex.slice(offset + length * 2)}`;
}

function normalizeImmutables(bytecode, immutableReferences) {
  let normalized = bytecode.toLowerCase();
  for (const references of Object.values(immutableReferences ?? {})) {
    for (const reference of references) {
      normalized = zeroRange(normalized, reference.start, reference.length);
    }
  }
  return normalized;
}

async function verifyRuntime(label, address, artifactName) {
  const artifact = await hre.artifacts.readArtifact(artifactName);
  const fullyQualifiedName = `${artifact.sourceName}:${artifact.contractName}`;
  const buildInfo = await hre.artifacts.getBuildInfo(fullyQualifiedName);
  if (!buildInfo) throw new Error(`Build info is unavailable for ${fullyQualifiedName}.`);
  const immutableReferences =
    buildInfo.output.contracts[artifact.sourceName][artifact.contractName]
      .evm.deployedBytecode.immutableReferences;
  const deployed = await hre.ethers.provider.getCode(address);
  if (deployed === "0x") throw new Error(`${label} has no bytecode at ${address}.`);
  const expected = normalizeImmutables(
    artifact.deployedBytecode,
    immutableReferences,
  );
  const actual = normalizeImmutables(deployed, immutableReferences);
  if (expected !== actual) {
    throw new Error(`${label} runtime bytecode does not match ${artifactName}.`);
  }
  console.log(`${label}: exact runtime match (${(deployed.length - 2) / 2} bytes)`);
}

async function main() {
  if (!fs.existsSync(candidatePath)) {
    throw new Error(`V6 candidate manifest not found at ${candidatePath}.`);
  }
  const manifest = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, EXPECTED_CHAIN_ID);
  assertEqual("manifest chain ID", manifest.chainId, EXPECTED_CHAIN_ID);
  assertEqual("USDC", manifest.contracts.usdc, EXPECTED_USDC);

  await verifyRuntime("V6 Factory", manifest.contracts.factory, "ArcForgeFactoryV6");
  await verifyRuntime("V6 FeeVault", manifest.contracts.feeVault, "ArcForgeFeeVaultV6");
  await verifyRuntime(
    "V6 CreatorRegistry",
    manifest.contracts.creatorRegistry,
    "ArcForgeCreatorRegistryV6",
  );
  await verifyRuntime(
    "V6 CurveDeployer",
    manifest.contracts.curveDeployer,
    "ArcForgeCurveDeployerV6",
  );

  const factory = await hre.ethers.getContractAt("ArcForgeFactoryV6", manifest.contracts.factory);
  const vault = await hre.ethers.getContractAt("ArcForgeFeeVaultV6", manifest.contracts.feeVault);
  const registry = await hre.ethers.getContractAt(
    "ArcForgeCreatorRegistryV6",
    manifest.contracts.creatorRegistry,
  );
  const curveDeployer = await hre.ethers.getContractAt(
    "ArcForgeCurveDeployerV6",
    manifest.contracts.curveDeployer,
  );

  assertEqual("factory USDC", await factory.usdc(), EXPECTED_USDC);
  assertEqual("factory vault", await factory.feeVault(), manifest.contracts.feeVault);
  assertEqual(
    "factory registry",
    await factory.creatorRegistry(),
    manifest.contracts.creatorRegistry,
  );
  assertEqual(
    "factory curve deployer",
    await factory.curveDeployer(),
    manifest.contracts.curveDeployer,
  );
  assertEqual("factory guardian", await factory.emergencyGuardian(), manifest.emergencyGuardian);
  assertEqual("launch fee", await factory.launchFee(), EXPECTED_LAUNCH_FEE);
  assertEqual("buy fee", await factory.buyFeeBps(), 100n);
  assertEqual("sell fee", await factory.sellFeeBps(), 100n);
  assertEqual("migration adapter", await factory.dexMigrationAdapter(), hre.ethers.ZeroAddress);
  assertEqual("migration locker", await factory.liquidityLocker(), hre.ethers.ZeroAddress);
  assertEqual("migration verifier", await factory.migrationVerifier(), hre.ethers.ZeroAddress);
  assertEqual("migration hash", await factory.currentMigrationConfigurationHash(), hre.ethers.ZeroHash);
  assertEqual("migration paused", await factory.migrationPaused(), true);
  assertEqual("vault recipient", await vault.feeRecipient(), manifest.feeRecipient);
  assertEqual("vault registrar", await vault.isRegistrar(manifest.contracts.factory), true);
  assertEqual("vault collector", await vault.isCollector(manifest.contracts.factory), true);
  assertEqual("registry factory", await registry.factory(), manifest.contracts.factory);
  assertEqual("curve deployer factory", await curveDeployer.factory(), manifest.contracts.factory);
  assertEqual("curve deployer owner", await curveDeployer.owner(), hre.ethers.ZeroAddress);

  const owners = await Promise.all([factory.owner(), vault.owner(), registry.owner()]);
  if (new Set(owners.map((owner) => owner.toLowerCase())).size !== 1) {
    throw new Error(`V6 owner mismatch: ${owners.join(", ")}.`);
  }
  console.log(`V6 candidate owner: ${owners[0]}`);
  console.log("V6 candidate wiring and exact runtime bytecode verified.");
  if (owners[0].toLowerCase() === manifest.deployer.toLowerCase()) {
    console.log("NOTICE: governance handoff is still required before activation.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
