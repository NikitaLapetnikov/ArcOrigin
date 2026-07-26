const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const MINIMUM_DELAY_SECONDS = 2 * 24 * 60 * 60;
const ZERO_ADDRESS = hre.ethers.ZeroAddress;
const ownableAbi = ["function owner() view returns (address)"];
const vaultAbi = [
  ...ownableAbi,
  "function feeRecipient() view returns (address)",
];
const timelockAbi = [
  "function getMinDelay() view returns (uint256)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
];
const safeAbi = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];

function requiredAddress(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (!value || !hre.ethers.isAddress(value) || value === ZERO_ADDRESS) {
    throw new Error(`${name} must be a non-zero address.`);
  }
  return hre.ethers.getAddress(value);
}

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

async function requireContract(label, address) {
  const code = await hre.ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`${label} has no deployed contract code at ${address}.`);
}

async function main() {
  const deploymentPath = path.join(__dirname, "..", "deployment", "arc-testnet.json");
  const manifest = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const governanceSafe = requiredAddress("GOVERNANCE_SAFE", manifest.governance?.governanceSafe);
  const treasurySafe = requiredAddress("TREASURY_SAFE", manifest.governance?.treasurySafe);
  const timelockAddress = requiredAddress("GOVERNANCE_TIMELOCK", manifest.governance?.timelock);
  for (const [label, address] of [
    ["GOVERNANCE_SAFE", governanceSafe],
    ["TREASURY_SAFE", treasurySafe],
    ["GOVERNANCE_TIMELOCK", timelockAddress],
  ]) await requireContract(label, address);

  async function verifySafePolicy(label, address) {
    const safe = new hre.ethers.Contract(address, safeAbi, hre.ethers.provider);
    const owners = await safe.getOwners();
    const threshold = await safe.getThreshold();
    if (owners.length !== 3 || threshold !== 2n) {
      throw new Error(`Unsafe ${label} policy: ${threshold}-of-${owners.length}. Expected 2-of-3.`);
    }
    const normalizedOwners = new Set(owners.map((owner) => owner.toLowerCase()));
    if (normalizedOwners.size !== owners.length) throw new Error(`${label} contains duplicate owners.`);
    return { owners, threshold };
  }
  const governancePolicy = await verifySafePolicy("governance Safe", governanceSafe);
  if (!sameAddress(treasurySafe, governanceSafe)) {
    await verifySafePolicy("treasury Safe", treasurySafe);
  }

  const timelock = new hre.ethers.Contract(timelockAddress, timelockAbi, hre.ethers.provider);
  const proposerRole = await timelock.PROPOSER_ROLE();
  const cancellerRole = await timelock.CANCELLER_ROLE();
  const executorRole = await timelock.EXECUTOR_ROLE();
  const adminRole = await timelock.DEFAULT_ADMIN_ROLE();
  const checks = [
    ["minimum delay", (await timelock.getMinDelay()) >= MINIMUM_DELAY_SECONDS],
    ["Safe proposer", await timelock.hasRole(proposerRole, governanceSafe)],
    ["Safe canceller", await timelock.hasRole(cancellerRole, governanceSafe)],
    ["public executor", await timelock.hasRole(executorRole, ZERO_ADDRESS)],
    ["self admin", await timelock.hasRole(adminRole, timelockAddress)],
    ["Safe is not direct admin", !(await timelock.hasRole(adminRole, governanceSafe))],
  ];
  for (const [label, passed] of checks) {
    if (!passed) throw new Error(`Governance verification failed: ${label}.`);
  }

  const ownershipTargets = [
    { label: "Active Factory", address: manifest.contracts.factory },
    { label: "FeeVault", address: manifest.contracts.feeVault },
    { label: "CreatorRegistry", address: manifest.contracts.creatorRegistry },
    ...(manifest.legacyFactories ?? []).map((address, index) => ({
      label: `Legacy Factory ${index + 1}`,
      address,
    })),
  ];
  for (const target of ownershipTargets) {
    const contract = new hre.ethers.Contract(target.address, ownableAbi, hre.ethers.provider);
    const owner = await contract.owner();
    if (!sameAddress(owner, timelockAddress)) {
      throw new Error(`${target.label} is owned by ${owner}, not the governance timelock.`);
    }
  }
  const vault = new hre.ethers.Contract(manifest.contracts.feeVault, vaultAbi, hre.ethers.provider);
  const recipient = await vault.feeRecipient();
  if (!sameAddress(recipient, treasurySafe)) {
    throw new Error(`FeeVault recipient is ${recipient}, not Treasury Safe ${treasurySafe}.`);
  }

  console.log(`Governance verified: ${governancePolicy.threshold}-of-${governancePolicy.owners.length} Safe -> ${await timelock.getMinDelay()}s timelock.`);
  console.log(`Governance Safe: ${governanceSafe}`);
  console.log(`Treasury Safe: ${treasurySafe}`);
  console.log(`Timelock: ${timelockAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
