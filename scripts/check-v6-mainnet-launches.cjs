const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ARC_MAINNET_CHAIN_ID = 5_042n;
const PAGE_SIZE = 100n;
const manifestPath = process.env.V6_MANIFEST
  ? path.resolve(process.env.V6_MANIFEST)
  : path.join(__dirname, "..", "deployment", "arc-mainnet-v6.local.json");

const factoryAbi = [
  "function paused() view returns (bool)",
  "function migrationPaused() view returns (bool)",
  "function getLaunchedTokenCount() view returns (uint256)",
  "function getLaunchedTokens(uint256 offset,uint256 limit) view returns (address[])",
  "function getTokenInfo(address token) view returns (tuple(address token,address curve,address creator,uint64 launchedAt,string metadataURI))",
];
const tokenAbi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];
const curveAbi = [
  "function isGraduated() view returns (bool)",
  "function isMigrated() view returns (bool)",
  "function getCurveProgress() view returns (uint256)",
  "function usdcReserve() view returns (uint256)",
  "function graduationThreshold() view returns (uint256)",
  "function migratedPool() view returns (address)",
  "function migrationConfigurationHash() view returns (bytes32)",
];

async function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== ARC_MAINNET_CHAIN_ID) {
    throw new Error(`Expected Arc mainnet chain 5042, received ${network.chainId}.`);
  }

  const factory = new hre.ethers.Contract(
    manifest.contracts.factory,
    factoryAbi,
    hre.ethers.provider,
  );
  const count = await factory.getLaunchedTokenCount();
  const tokens = [];
  for (let offset = 0n; offset < count; offset += PAGE_SIZE) {
    tokens.push(...await factory.getLaunchedTokens(offset, PAGE_SIZE));
  }

  const launches = await Promise.all(
    tokens.map(async (tokenAddress) => {
      const info = await factory.getTokenInfo(tokenAddress);
      const token = new hre.ethers.Contract(tokenAddress, tokenAbi, hre.ethers.provider);
      const curve = new hre.ethers.Contract(info.curve, curveAbi, hre.ethers.provider);
      const [
        name,
        symbol,
        graduated,
        migrated,
        progressBps,
        usdcReserve,
        graduationThreshold,
        migratedPool,
        migrationConfigurationHash,
      ] = await Promise.all([
        token.name(),
        token.symbol(),
        curve.isGraduated(),
        curve.isMigrated(),
        curve.getCurveProgress(),
        curve.usdcReserve(),
        curve.graduationThreshold(),
        curve.migratedPool(),
        curve.migrationConfigurationHash(),
      ]);

      return {
        token: tokenAddress,
        curve: info.curve,
        creator: info.creator,
        launchedAt: new Date(Number(info.launchedAt) * 1_000).toISOString(),
        metadataURI: info.metadataURI,
        name,
        symbol,
        graduated,
        migrated,
        progressBps: Number(progressBps),
        usdcReserve: hre.ethers.formatUnits(usdcReserve, 6),
        graduationThreshold: hre.ethers.formatUnits(graduationThreshold, 6),
        migratedPool,
        migrationConfigurationHash,
        eligibleForMigration: graduated && !migrated,
      };
    }),
  );

  console.log(
    JSON.stringify(
      {
        chainId: Number(network.chainId),
        factory: manifest.contracts.factory,
        launchesPaused: await factory.paused(),
        migrationsPaused: await factory.migrationPaused(),
        launchedTokenCount: Number(count),
        eligibleMigrationCount: launches.filter(
          (launch) => launch.eligibleForMigration,
        ).length,
        launches,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
