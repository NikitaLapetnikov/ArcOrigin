const hre = require("hardhat");

const ARC_MAINNET_CHAIN_ID = 5_042n;
const ARC_USDC = "0x3600000000000000000000000000000000000000";

function requiredAddress(name) {
  const value = process.env[name]?.trim();
  if (!value || !hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero address.`);
  }
  return hre.ethers.getAddress(value);
}

async function main() {
  if (!process.env.ARC_MAINNET_RPC_URL?.trim()) {
    throw new Error("ARC_MAINNET_RPC_URL must be explicitly configured.");
  }
  const governanceSafe = requiredAddress("MAINNET_GOVERNANCE_SAFE");
  const expectedDeployer = requiredAddress("MAINNET_EXPECTED_DEPLOYER");
  const retiredFactory = requiredAddress("MAINNET_RETIRED_FACTORY_ADDRESS");
  const feeVault = requiredAddress("NEXT_PUBLIC_MAINNET_FEE_VAULT_ADDRESS");
  const creatorRegistry = requiredAddress("NEXT_PUBLIC_MAINNET_CREATOR_REGISTRY_ADDRESS");
  const provider = hre.ethers.provider;
  const network = await provider.getNetwork();
  if (network.chainId !== ARC_MAINNET_CHAIN_ID) {
    throw new Error(`Expected Arc mainnet ${ARC_MAINNET_CHAIN_ID}, received ${network.chainId}.`);
  }

  const safe = new hre.ethers.Contract(
    governanceSafe,
    [
      "function getOwners() view returns (address[])",
      "function getThreshold() view returns (uint256)",
      "function nonce() view returns (uint256)",
    ],
    provider,
  );
  const factory = new hre.ethers.Contract(
    retiredFactory,
    [
      "function owner() view returns (address)",
      "function emergencyGuardian() view returns (address)",
      "function paused() view returns (bool)",
      "function migrationPaused() view returns (bool)",
      "function getLaunchedTokenCount() view returns (uint256)",
    ],
    provider,
  );
  const vault = new hre.ethers.Contract(
    feeVault,
    [
      "function owner() view returns (address)",
      "function feeRecipient() view returns (address)",
      "function isRegistrar(address) view returns (bool)",
      "function isCollector(address) view returns (bool)",
    ],
    provider,
  );
  const registry = new hre.ethers.Contract(
    creatorRegistry,
    ["function owner() view returns (address)", "function factory() view returns (address)"],
    provider,
  );
  const usdc = new hre.ethers.Contract(
    ARC_USDC,
    ["function balanceOf(address) view returns (uint256)"],
    provider,
  );

  const [
    blockNumber,
    owners,
    threshold,
    safeNonce,
    factoryOwner,
    emergencyGuardian,
    launchesPaused,
    migrationsPaused,
    launchCount,
    vaultOwner,
    feeRecipient,
    retiredRegistrar,
    retiredCollector,
    registryOwner,
    registryFactory,
    vaultUsdcBalance,
    deployerNativeBalance,
  ] = await Promise.all([
    provider.getBlockNumber(),
    safe.getOwners(),
    safe.getThreshold(),
    safe.nonce(),
    factory.owner(),
    factory.emergencyGuardian(),
    factory.paused(),
    factory.migrationPaused(),
    factory.getLaunchedTokenCount(),
    vault.owner(),
    vault.feeRecipient(),
    vault.isRegistrar(retiredFactory),
    vault.isCollector(retiredFactory),
    registry.owner(),
    registry.factory(),
    usdc.balanceOf(feeVault),
    provider.getBalance(expectedDeployer),
  ]);

  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    chainId: Number(network.chainId),
    blockNumber,
    governanceSafe: {
      address: governanceSafe,
      owners,
      threshold: Number(threshold),
      nonce: safeNonce.toString(),
    },
    deployer: {
      address: expectedDeployer,
      nativeBalance: deployerNativeBalance.toString(),
    },
    retiredFactory: {
      address: retiredFactory,
      owner: factoryOwner,
      emergencyGuardian,
      launchesPaused,
      migrationsPaused,
      launchCount: launchCount.toString(),
    },
    feeVault: {
      address: feeVault,
      owner: vaultOwner,
      feeRecipient,
      retiredFactoryIsRegistrar: retiredRegistrar,
      retiredFactoryIsCollector: retiredCollector,
      usdcBalance: vaultUsdcBalance.toString(),
    },
    creatorRegistry: {
      address: creatorRegistry,
      owner: registryOwner,
      activeFactory: registryFactory,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
