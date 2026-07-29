const hre = require("hardhat");

const factoryInterface = new hre.ethers.Interface([
  "function setMigrationConfiguration(address adapter,address locker,address verifier)",
  "function unpauseMigrations()",
  "function unpauseLaunches()",
]);

function requiredAddress(name) {
  const value = process.env[name]?.trim();
  if (!value || !hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero address.`);
  }
  return hre.ethers.getAddress(value);
}

async function requireContract(label, address) {
  if (await hre.ethers.provider.getCode(address) === "0x") {
    throw new Error(`${label} has no deployed bytecode at ${address}.`);
  }
}

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 5_042n) {
    throw new Error(`Expected Arc mainnet chain ID 5042, received ${network.chainId}.`);
  }
  const factory = requiredAddress("NEXT_PUBLIC_MAINNET_FACTORY_ADDRESS");
  const adapter = requiredAddress("ARCORIGIN_MIGRATION_ADAPTER");
  const locker = requiredAddress("ARCORIGIN_LIQUIDITY_LOCKER");
  const verifier = requiredAddress("ARCORIGIN_MIGRATION_VERIFIER");
  await Promise.all([
    requireContract("Factory", factory),
    requireContract("migration adapter", adapter),
    requireContract("liquidity locker", locker),
    requireContract("migration verifier", verifier),
  ]);

  console.log(JSON.stringify({
    warning: "Execute each operation separately through the reviewed 2-of-3 Governance Safe. Never combine configuration and activation into one Safe transaction.",
    order: [
      {
        step: 1,
        name: "configure-migration-and-keep-paused",
        target: factory,
        value: "0",
        calldata: factoryInterface.encodeFunctionData("setMigrationConfiguration", [
          adapter,
          locker,
          verifier,
        ]),
      },
      {
        step: 2,
        name: "unpause-migrations-after-readiness",
        target: factory,
        value: "0",
        calldata: factoryInterface.encodeFunctionData("unpauseMigrations"),
      },
      {
        step: 3,
        name: "unpause-launches-last",
        target: factory,
        value: "0",
        calldata: factoryInterface.encodeFunctionData("unpauseLaunches"),
      },
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
