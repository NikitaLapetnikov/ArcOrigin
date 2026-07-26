const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const MINIMUM_DELAY_SECONDS = 2 * 24 * 60 * 60;
const ZERO_ADDRESS = hre.ethers.ZeroAddress;
const ownableAbi = [
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner)",
];
const vaultAbi = [
  ...ownableAbi,
  "function feeRecipient() view returns (address)",
  "function setFeeRecipient(address newRecipient)",
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

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

async function waitFor(transaction, label) {
  console.log(`${label}: ${transaction.hash}`);
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${label} reverted.`);
}

async function main() {
  const deploymentPath = path.join(__dirname, "..", "deployment", "arc-testnet.json");
  const manifest = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const governanceSafe = requiredAddress("GOVERNANCE_SAFE");
  const treasurySafe = requiredAddress("TREASURY_SAFE");
  const timelockAddress = requiredAddress("GOVERNANCE_TIMELOCK");
  const execute = process.env.EXECUTE_ADMIN_HANDOFF === "true";

  await requireTwoOfThreeSafe("GOVERNANCE_SAFE", governanceSafe);
  if (!sameAddress(treasurySafe, governanceSafe)) {
    await requireTwoOfThreeSafe("TREASURY_SAFE", treasurySafe);
  }
  await requireContract("GOVERNANCE_TIMELOCK", timelockAddress);

  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("DEPLOYER_PRIVATE_KEY is required for ownership handoff.");
  if (!sameAddress(signer.address, manifest.deployer)) {
    throw new Error(`Connected signer ${signer.address} is not manifest deployer ${manifest.deployer}.`);
  }

  const timelock = new hre.ethers.Contract(timelockAddress, timelockAbi, hre.ethers.provider);
  const proposerRole = await timelock.PROPOSER_ROLE();
  const cancellerRole = await timelock.CANCELLER_ROLE();
  const executorRole = await timelock.EXECUTOR_ROLE();
  const adminRole = await timelock.DEFAULT_ADMIN_ROLE();
  const minimumDelay = await timelock.getMinDelay();
  const timelockChecks = [
    ["minimum delay is at least 48 hours", minimumDelay >= MINIMUM_DELAY_SECONDS],
    ["governance Safe is proposer", await timelock.hasRole(proposerRole, governanceSafe)],
    ["governance Safe is canceller", await timelock.hasRole(cancellerRole, governanceSafe)],
    ["execution is permissionless after delay", await timelock.hasRole(executorRole, ZERO_ADDRESS)],
    ["timelock is self-administered", await timelock.hasRole(adminRole, timelockAddress)],
    ["deployer has no timelock admin role", !(await timelock.hasRole(adminRole, signer.address))],
    ["governance Safe has no direct timelock admin role", !(await timelock.hasRole(adminRole, governanceSafe))],
  ];
  for (const [label, passed] of timelockChecks) {
    if (!passed) throw new Error(`Unsafe timelock configuration: ${label} check failed.`);
  }

  const ownershipTargets = [
    ...Array.from(new Set(manifest.legacyFactories ?? [])).map((address, index) => ({
      label: `Legacy Factory ${index + 1}`,
      address,
    })),
    { label: "Active Factory", address: manifest.contracts.factory },
    { label: "FeeVault", address: manifest.contracts.feeVault },
    { label: "CreatorRegistry", address: manifest.contracts.creatorRegistry },
  ];
  for (const target of ownershipTargets) await requireContract(target.label, target.address);

  const pending = [];
  for (const target of ownershipTargets) {
    const contract = new hre.ethers.Contract(target.address, ownableAbi, signer);
    const owner = await contract.owner();
    if (sameAddress(owner, timelockAddress)) continue;
    if (!sameAddress(owner, signer.address)) {
      throw new Error(`${target.label} owner is ${owner}; expected signer or timelock.`);
    }
    pending.push({ type: "ownership", target, contract });
  }

  const vault = new hre.ethers.Contract(manifest.contracts.feeVault, vaultAbi, signer);
  const currentRecipient = await vault.feeRecipient();
  const recipientNeedsUpdate = !sameAddress(currentRecipient, treasurySafe);

  console.log(`Mode: ${execute ? "EXECUTE" : "DRY RUN"}`);
  console.log(`Governance Safe: ${governanceSafe}`);
  console.log(`Treasury Safe: ${treasurySafe}`);
  console.log(`Timelock: ${timelockAddress}`);
  if (recipientNeedsUpdate) {
    console.log(`FeeVault recipient: ${currentRecipient} -> ${treasurySafe}`);
  }
  for (const item of pending) {
    console.log(`${item.target.label} owner -> ${timelockAddress}`);
  }

  if (!execute) {
    console.log("No transactions sent. Re-run with EXECUTE_ADMIN_HANDOFF=true only after independent address review.");
    return;
  }
  if (process.env.CONFIRM_ADMIN_HANDOFF !== timelockAddress) {
    throw new Error("Set CONFIRM_ADMIN_HANDOFF to the exact timelock address to authorize execution.");
  }

  // Transfer the least critical legacy contracts first. CreatorRegistry is last
  // because it selects the active launch factory.
  if (recipientNeedsUpdate) {
    await waitFor(await vault.setFeeRecipient(treasurySafe), "FeeVault recipient update");
  }
  for (const item of pending) {
    await waitFor(
      await item.contract.transferOwnership(timelockAddress),
      `${item.target.label} ownership transfer`,
    );
  }

  if (!sameAddress(await vault.feeRecipient(), treasurySafe)) {
    throw new Error("FeeVault recipient verification failed after handoff.");
  }
  for (const target of ownershipTargets) {
    const contract = new hre.ethers.Contract(target.address, ownableAbi, hre.ethers.provider);
    if (!sameAddress(await contract.owner(), timelockAddress)) {
      throw new Error(`${target.label} ownership verification failed after handoff.`);
    }
  }
  manifest.feeRecipient = treasurySafe;
  manifest.status = "V5_GOVERNED";
  manifest.governance = {
    governanceSafe,
    treasurySafe,
    timelock: timelockAddress,
    minimumDelaySeconds: Number(minimumDelay),
    previousOwner: signer.address,
    ownershipTransferredAt: new Date().toISOString(),
  };
  fs.writeFileSync(deploymentPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("Admin handoff verified. Future owner actions must pass through the governance timelock.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
