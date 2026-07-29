const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const MINIMUM_DELAY_SECONDS = 2n * 24n * 60n * 60n;
const ZERO_ADDRESS = hre.ethers.ZeroAddress;
const ZERO_HASH = hre.ethers.ZeroHash;
const candidatePath = process.env.V6_MANIFEST
  ? path.resolve(process.env.V6_MANIFEST)
  : path.join(__dirname, "..", "deployment", "arcTestnet-v6.local.json");
const outputPath = process.env.V6_HANDOFF_OUTPUT
  ? path.resolve(process.env.V6_HANDOFF_OUTPUT)
  : path.join(__dirname, "..", "deployment", "v6-governance-handoff.local.json");
const ownable2StepAbi = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
];
const timelockAbi = [
  "function getMinDelay() view returns (uint256)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function hashOperationBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt) view returns (bytes32)",
  "function scheduleBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt,uint256 delay)",
  "function executeBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt) payable",
];
const safeAbi = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];

function requiredAddress(name) {
  const aliases = {
    GOVERNANCE_SAFE: "MAINNET_GOVERNANCE_SAFE",
    TREASURY_SAFE: "MAINNET_TREASURY_SAFE",
    GOVERNANCE_TIMELOCK: "MAINNET_GOVERNANCE_TIMELOCK",
  };
  const value = process.env[name] ?? process.env[aliases[name]];
  if (!value || !hre.ethers.isAddress(value) || value === ZERO_ADDRESS) {
    throw new Error(`${name} must be a non-zero address.`);
  }
  return hre.ethers.getAddress(value);
}

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

async function requireContract(label, address) {
  if (await hre.ethers.provider.getCode(address) === "0x") {
    throw new Error(`${label} has no contract code at ${address}.`);
  }
}

async function requireTwoOfThreeSafe(label, address) {
  await requireContract(label, address);
  const safe = new hre.ethers.Contract(address, safeAbi, hre.ethers.provider);
  const owners = await safe.getOwners();
  const threshold = await safe.getThreshold();
  if (threshold !== 2n || owners.length !== 3) {
    throw new Error(`${label} must be exactly 2-of-3.`);
  }
  if (new Set(owners.map((owner) => owner.toLowerCase())).size !== 3) {
    throw new Error(`${label} contains duplicate owners.`);
  }
}

async function main() {
  if (!fs.existsSync(candidatePath)) {
    throw new Error(`V6 candidate manifest not found at ${candidatePath}.`);
  }
  const manifest = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  const governanceSafe = requiredAddress("GOVERNANCE_SAFE");
  const treasurySafe = requiredAddress("TREASURY_SAFE");
  const timelockAddress = requiredAddress("GOVERNANCE_TIMELOCK");
  const network = await hre.ethers.provider.getNetwork();
  if (Number(network.chainId) !== manifest.chainId) {
    throw new Error(
      `Manifest chain ID ${manifest.chainId} does not match connected chain ${network.chainId}.`,
    );
  }
  const execute = process.env.EXECUTE_V6_HANDOFF_PREPARE === "true";
  await requireTwoOfThreeSafe("GOVERNANCE_SAFE", governanceSafe);
  await requireTwoOfThreeSafe("TREASURY_SAFE", treasurySafe);
  await requireContract("GOVERNANCE_TIMELOCK", timelockAddress);
  if (!sameAddress(manifest.feeRecipient, treasurySafe)) {
    throw new Error("Candidate FeeVault recipient is not the reviewed Treasury Safe.");
  }
  if (
    manifest.governance &&
    (!sameAddress(manifest.governance.safe, governanceSafe) ||
      !sameAddress(manifest.governance.timelock, timelockAddress))
  ) {
    throw new Error("Candidate governance addresses do not match the reviewed handoff inputs.");
  }

  const [signer] = await hre.ethers.getSigners();
  if (!signer || !sameAddress(signer.address, manifest.deployer)) {
    throw new Error("Connected signer must be the V6 candidate deployer.");
  }
  const timelock = new hre.ethers.Contract(timelockAddress, timelockAbi, hre.ethers.provider);
  const delay = await timelock.getMinDelay();
  if (delay < MINIMUM_DELAY_SECONDS) throw new Error("Timelock delay is below 48 hours.");
  const roleChecks = [
    [await timelock.PROPOSER_ROLE(), governanceSafe, true],
    [await timelock.CANCELLER_ROLE(), governanceSafe, true],
    [await timelock.EXECUTOR_ROLE(), ZERO_ADDRESS, true],
    [await timelock.DEFAULT_ADMIN_ROLE(), timelockAddress, true],
    [await timelock.DEFAULT_ADMIN_ROLE(), signer.address, false],
    [await timelock.DEFAULT_ADMIN_ROLE(), governanceSafe, false],
  ];
  for (const [role, account, expected] of roleChecks) {
    if (await timelock.hasRole(role, account) !== expected) {
      throw new Error(`Unsafe timelock role layout for ${account}.`);
    }
  }

  const targets = [
    { label: "V6 Factory", address: manifest.contracts.factory },
    { label: "V6 FeeVault", address: manifest.contracts.feeVault },
    { label: "V6 CreatorRegistry", address: manifest.contracts.creatorRegistry },
  ];
  for (const target of targets) await requireContract(target.label, target.address);
  const contracts = targets.map(
    (target) => new hre.ethers.Contract(target.address, ownable2StepAbi, signer),
  );
  for (let index = 0; index < contracts.length; index += 1) {
    const owner = await contracts[index].owner();
    const pendingOwner = await contracts[index].pendingOwner();
    const validOwner = sameAddress(owner, signer.address) || sameAddress(owner, timelockAddress);
    const validPending =
      pendingOwner === ZERO_ADDRESS || sameAddress(pendingOwner, timelockAddress);
    if (!validOwner || !validPending) {
      throw new Error(`${targets[index].label} has unexpected ownership state.`);
    }
  }

  console.log(`Mode: ${execute ? "PREPARE OWNERSHIP" : "DRY RUN"}`);
  console.log(`Governance Safe: ${governanceSafe}`);
  console.log(`Treasury Safe: ${treasurySafe}`);
  console.log(`Timelock: ${timelockAddress}`);
  if (!execute) {
    console.log("No transaction sent. Exact Safe batch calldata will be produced after preparation.");
    return;
  }
  if (process.env.CONFIRM_V6_HANDOFF !== timelockAddress) {
    throw new Error("CONFIRM_V6_HANDOFF must equal the exact timelock address.");
  }

  for (let index = 0; index < contracts.length; index += 1) {
    const owner = await contracts[index].owner();
    if (sameAddress(owner, timelockAddress)) continue;
    if (!sameAddress(await contracts[index].pendingOwner(), timelockAddress)) {
      const transaction = await contracts[index].transferOwnership(timelockAddress);
      console.log(`${targets[index].label} pending owner transaction: ${transaction.hash}`);
      const receipt = await transaction.wait();
      if (receipt.status !== 1) throw new Error(`${targets[index].label} preparation reverted.`);
    }
    if (!sameAddress(await contracts[index].pendingOwner(), timelockAddress)) {
      throw new Error(`${targets[index].label} pending owner verification failed.`);
    }
  }

  const ownershipTargets = targets.map((target) => target.address);
  const values = ownershipTargets.map(() => 0n);
  const ownableInterface = new hre.ethers.Interface(ownable2StepAbi);
  const payloads = ownershipTargets.map(() =>
    ownableInterface.encodeFunctionData("acceptOwnership"),
  );
  const saltLabel = process.env.V6_HANDOFF_SALT_LABEL;
  if (!saltLabel || saltLabel.trim().length < 12) {
    throw new Error("V6_HANDOFF_SALT_LABEL must be a unique descriptive label.");
  }
  const salt = hre.ethers.id(saltLabel.trim());
  const operationId = await timelock.hashOperationBatch(
    ownershipTargets,
    values,
    payloads,
    ZERO_HASH,
    salt,
  );
  const scheduleCalldata = timelock.interface.encodeFunctionData("scheduleBatch", [
    ownershipTargets,
    values,
    payloads,
    ZERO_HASH,
    salt,
    delay,
  ]);
  const executeCalldata = timelock.interface.encodeFunctionData("executeBatch", [
    ownershipTargets,
    values,
    payloads,
    ZERO_HASH,
    salt,
  ]);
  const plan = {
    createdAt: new Date().toISOString(),
    chainId: Number(network.chainId),
    candidateManifest: candidatePath,
    governanceSafe,
    treasurySafe,
    timelock: timelockAddress,
    minimumDelaySeconds: delay.toString(),
    targets,
    operationId,
    saltLabel: saltLabel.trim(),
    salt,
    safeScheduleTransaction: {
      to: timelockAddress,
      value: "0",
      data: scheduleCalldata,
    },
    permissionlessExecuteAfterDelay: {
      to: timelockAddress,
      value: "0",
      data: executeCalldata,
    },
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
  console.log(JSON.stringify(plan, null, 2));
  console.log(`Handoff plan written to ${outputPath}.`);
  console.log("Ownership remains with the deployer until the timelock batch is executed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
