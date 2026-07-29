const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_MAINNET_CHAIN_ID = 5_042n;
const manifestPath = process.env.V6_MANIFEST
  ? path.resolve(process.env.V6_MANIFEST)
  : path.join(__dirname, "..", "deployment", "arc-mainnet-v6.local.json");
const outputPath = process.env.V6_SOURCE_VERIFICATION_OUTPUT
  ? path.resolve(process.env.V6_SOURCE_VERIFICATION_OUTPUT)
  : path.join(
    __dirname,
    "..",
    "deployment",
    "v6-mainnet-source-verification.local.json",
  );

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

async function verifyContract(candidate) {
  try {
    await hre.run("verify:verify", {
      address: candidate.address,
      constructorArguments: candidate.constructorArguments,
      contract: candidate.contract,
    });
    return { ...candidate, verified: true, alreadyVerified: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already verified/i.test(message)) {
      return { ...candidate, verified: true, alreadyVerified: true };
    }
    throw new Error(`${candidate.label} source verification failed: ${message}`, {
      cause: error,
    });
  }
}

async function main() {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`V6 mainnet manifest not found at ${manifestPath}.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, ARC_MAINNET_CHAIN_ID);
  assertEqual("manifest chain ID", manifest.chainId, ARC_MAINNET_CHAIN_ID);

  const deployer = manifest.deployer;
  const safe = manifest.governance.safe;
  const { contracts, dexMigration } = manifest;
  const candidates = [
    {
      label: "V6 FeeVault",
      address: contracts.feeVault,
      contract: "contracts/ArcForgeFeeVaultV6.sol:ArcForgeFeeVaultV6",
      constructorArguments: [deployer, safe],
    },
    {
      label: "V6 CreatorRegistry",
      address: contracts.creatorRegistry,
      contract:
        "contracts/ArcForgeCreatorRegistryV6.sol:ArcForgeCreatorRegistryV6",
      constructorArguments: [deployer],
    },
    {
      label: "V6 CurveDeployer",
      address: contracts.curveDeployer,
      contract: "contracts/ArcForgeCurveDeployerV6.sol:ArcForgeCurveDeployerV6",
      constructorArguments: [deployer],
    },
    {
      label: "V6 Factory",
      address: contracts.factory,
      contract: "contracts/ArcForgeFactoryV6.sol:ArcForgeFactoryV6",
      constructorArguments: [
        deployer,
        manifest.emergencyGuardian,
        contracts.usdc,
        contracts.feeVault,
        contracts.creatorRegistry,
        contracts.curveDeployer,
        10n * 10n ** 6n,
        2_500n * 10n ** 6n,
        10_000n * 10n ** 6n,
      ],
    },
    {
      label: "Uniswap V3 MigrationAdapter",
      address: dexMigration.adapter,
      contract:
        "contracts/uniswap/ArcOriginUniswapV3MigrationAdapter.sol:ArcOriginUniswapV3MigrationAdapter",
      constructorArguments: [
        contracts.factory,
        "0xf0db7b58379503491d857db50ac9ece64c653918",
        "0x39654a85a4c05127f5fd6ed22caec077a0fb1377",
        contracts.usdc,
      ],
    },
    {
      label: "Uniswap V3 LiquidityLocker",
      address: dexMigration.locker,
      contract:
        "contracts/uniswap/ArcOriginUniswapV3LiquidityLocker.sol:ArcOriginUniswapV3LiquidityLocker",
      constructorArguments: [
        dexMigration.adapter,
        "0x39654a85a4c05127f5fd6ed22caec077a0fb1377",
        contracts.feeVault,
      ],
    },
    {
      label: "Uniswap V3 MigrationVerifier",
      address: dexMigration.verifier,
      contract:
        "contracts/uniswap/ArcOriginUniswapV3MigrationVerifier.sol:ArcOriginUniswapV3MigrationVerifier",
      constructorArguments: [
        contracts.factory,
        "0xf0db7b58379503491d857db50ac9ece64c653918",
        "0x39654a85a4c05127f5fd6ed22caec077a0fb1377",
        contracts.usdc,
        dexMigration.adapter,
        dexMigration.locker,
      ],
    },
  ];

  for (const candidate of candidates) {
    const code = await hre.ethers.provider.getCode(candidate.address);
    if (code === "0x") {
      throw new Error(`${candidate.label} has no bytecode at ${candidate.address}.`);
    }
  }

  const results = [];
  for (const candidate of candidates) {
    console.log(`Verifying ${candidate.label} at ${candidate.address}...`);
    results.push(await verifyContract(candidate));
  }

  const report = {
    verifiedAt: new Date().toISOString(),
    chainId: Number(network.chainId),
    explorer: "https://arc-mainnet.cloud.blockscout.com",
    contracts: results.map(
      ({ constructorArguments: _constructorArguments, ...result }) => result,
    ),
    verified: results.every((result) => result.verified),
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Verification report written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
