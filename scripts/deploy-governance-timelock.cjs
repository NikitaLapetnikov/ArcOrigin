const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const MINIMUM_DELAY_SECONDS = 2 * 24 * 60 * 60;
const ZERO_ADDRESS = hre.ethers.ZeroAddress;
const safeAbi = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];

function requiredAddress(name) {
  const value = process.env[name];
  if (!value || !hre.ethers.isAddress(value) || value === ZERO_ADDRESS) {
    throw new Error(`${name} must be a non-zero address.`);
  }
  return hre.ethers.getAddress(value);
}

async function requireContract(label, address) {
  const code = await hre.ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`${label} has no deployed contract code at ${address}.`);
}

async function requireTwoOfThreeSafe(label, address) {
  await requireContract(label, address);
  const safe = new hre.ethers.Contract(address, safeAbi, hre.ethers.provider);
  const owners = await safe.getOwners();
  const threshold = await safe.getThreshold();
  if (owners.length !== 3 || threshold !== 2n) {
    throw new Error(`${label} must be configured as exactly 2-of-3; received ${threshold}-of-${owners.length}.`);
  }
  if (new Set(owners.map((owner) => owner.toLowerCase())).size !== 3) {
    throw new Error(`${label} contains duplicate owners.`);
  }
}

async function main() {
  const governanceSafe = requiredAddress("GOVERNANCE_SAFE");
  const configuredDelay = Number(process.env.TIMELOCK_DELAY_SECONDS ?? MINIMUM_DELAY_SECONDS);
  if (!Number.isSafeInteger(configuredDelay) || configuredDelay < MINIMUM_DELAY_SECONDS) {
    throw new Error(`TIMELOCK_DELAY_SECONDS must be an integer of at least ${MINIMUM_DELAY_SECONDS}.`);
  }
  await requireTwoOfThreeSafe("GOVERNANCE_SAFE", governanceSafe);

  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY is required for deployment.");
  const network = await hre.ethers.provider.getNetwork();
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  if (balance === 0n) throw new Error("The deployer has no native token for gas.");

  const Timelock = await hre.ethers.getContractFactory("ArcOriginGovernanceTimelock");
  const timelock = await Timelock.deploy(configuredDelay, governanceSafe);
  const deploymentTransaction = timelock.deploymentTransaction();
  console.log(`Governance timelock deployment submitted: ${deploymentTransaction.hash}`);
  const receipt = await deploymentTransaction.wait();
  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();

  const proposerRole = await timelock.PROPOSER_ROLE();
  const cancellerRole = await timelock.CANCELLER_ROLE();
  const executorRole = await timelock.EXECUTOR_ROLE();
  const adminRole = await timelock.DEFAULT_ADMIN_ROLE();
  const checks = [
    ["minimum delay", await timelock.getMinDelay(), BigInt(configuredDelay)],
    ["Safe proposer", await timelock.hasRole(proposerRole, governanceSafe), true],
    ["Safe canceller", await timelock.hasRole(cancellerRole, governanceSafe), true],
    ["public executor", await timelock.hasRole(executorRole, ZERO_ADDRESS), true],
    ["self admin", await timelock.hasRole(adminRole, timelockAddress), true],
    ["deployer is not admin", await timelock.hasRole(adminRole, deployer.address), false],
    ["Safe is not admin", await timelock.hasRole(adminRole, governanceSafe), false],
  ];
  for (const [label, actual, expected] of checks) {
    if (String(actual) !== String(expected)) {
      throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
    }
  }

  const outputPath = path.join(__dirname, "..", "deployment", `governance-${network.chainId}.local.json`);
  if (fs.existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite existing governance manifest at ${outputPath}.`);
  }
  const manifest = {
    network: network.name,
    chainId: Number(network.chainId),
    governanceSafe,
    treasurySafe: null,
    timelock: timelockAddress,
    minimumDelaySeconds: configuredDelay,
    deployedBy: deployer.address,
    deploymentTx: deploymentTransaction.hash,
    deploymentBlock: receipt.blockNumber,
    deployedAt: new Date().toISOString(),
    ownershipTransferred: false,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`Governance timelock: ${timelockAddress}`);
  console.log(`Governance manifest: ${outputPath}`);
  console.log("No protocol ownership was changed. Run the admin handoff dry-run next.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
