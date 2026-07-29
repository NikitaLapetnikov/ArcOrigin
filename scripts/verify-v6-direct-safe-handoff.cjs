const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ZERO_ADDRESS = hre.ethers.ZeroAddress;
const manifestPath = process.env.V6_MANIFEST
  ? path.resolve(process.env.V6_MANIFEST)
  : path.join(__dirname, "..", "deployment", "arc-mainnet-v6.local.json");
const timelockPlanPath = process.env.V6_TIMELOCK_HANDOFF_PLAN
  ? path.resolve(process.env.V6_TIMELOCK_HANDOFF_PLAN)
  : path.join(
    __dirname,
    "..",
    "deployment",
    "v6-mainnet-governance-handoff.local.json",
  );
const outputPath = process.env.V6_DIRECT_SAFE_VERIFICATION_OUTPUT
  ? path.resolve(process.env.V6_DIRECT_SAFE_VERIFICATION_OUTPUT)
  : path.join(
    __dirname,
    "..",
    "deployment",
    "v6-mainnet-direct-safe-handoff-execution.local.json",
  );

const ownableAbi = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
];
const safeAbi = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];
const timelockAbi = [
  "function isOperation(bytes32 id) view returns (bool)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
];

function sameAddress(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

async function requireContract(label, address) {
  if (!hre.ethers.isAddress(address) || address === ZERO_ADDRESS) {
    throw new Error(`${label} is not a valid non-zero address.`);
  }
  if (await hre.ethers.provider.getCode(address) === "0x") {
    throw new Error(`${label} has no contract code at ${address}.`);
  }
}

async function main() {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`V6 manifest not found at ${manifestPath}.`);
  }
  if (!fs.existsSync(timelockPlanPath)) {
    throw new Error(`Timelock handoff plan not found at ${timelockPlanPath}.`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const timelockPlan = JSON.parse(fs.readFileSync(timelockPlanPath, "utf8"));
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, manifest.chainId);

  const governanceSafe = hre.ethers.getAddress(manifest.governance.safe);
  const timelockAddress = hre.ethers.getAddress(manifest.governance.timelock);
  const operationId = timelockPlan.operationId;
  const targets = [
    { label: "V6 Factory", address: manifest.contracts.factory },
    { label: "V6 FeeVault", address: manifest.contracts.feeVault },
    { label: "V6 CreatorRegistry", address: manifest.contracts.creatorRegistry },
  ].map((target) => ({
    label: target.label,
    address: hre.ethers.getAddress(target.address),
  }));

  await requireContract("Governance Safe", governanceSafe);
  await requireContract("Former Governance Timelock", timelockAddress);
  for (const target of targets) {
    await requireContract(target.label, target.address);
  }

  const safe = new hre.ethers.Contract(governanceSafe, safeAbi, hre.ethers.provider);
  const [safeOwners, safeThreshold] = await Promise.all([
    safe.getOwners(),
    safe.getThreshold(),
  ]);
  if (safeThreshold !== 2n || safeOwners.length !== 3) {
    throw new Error("Governance Safe is not the reviewed 2-of-3 configuration.");
  }
  if (new Set(safeOwners.map((owner) => owner.toLowerCase())).size !== 3) {
    throw new Error("Governance Safe contains duplicate owners.");
  }

  const ownership = await Promise.all(
    targets.map(async (target) => {
      const contract = new hre.ethers.Contract(
        target.address,
        ownableAbi,
        hre.ethers.provider,
      );
      return {
        ...target,
        owner: await contract.owner(),
        pendingOwner: await contract.pendingOwner(),
      };
    }),
  );
  for (const target of ownership) {
    if (!sameAddress(target.owner, governanceSafe)) {
      throw new Error(`${target.label} is not owned by the Governance Safe.`);
    }
    if (!sameAddress(target.pendingOwner, ZERO_ADDRESS)) {
      throw new Error(`${target.label} still has a pending owner.`);
    }
  }

  const timelock = new hre.ethers.Contract(
    timelockAddress,
    timelockAbi,
    hre.ethers.provider,
  );
  const operationState = {
    isOperation: await timelock.isOperation(operationId),
    isPending: await timelock.isOperationPending(operationId),
    isReady: await timelock.isOperationReady(operationId),
    isDone: await timelock.isOperationDone(operationId),
  };
  if (Object.values(operationState).some(Boolean)) {
    throw new Error("Former Timelock ownership operation was not fully cancelled.");
  }

  let executionTransaction = null;
  const executionHash = process.env.V6_DIRECT_SAFE_EXECUTION_TX_HASH;
  if (executionHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(executionHash)) {
      throw new Error("V6_DIRECT_SAFE_EXECUTION_TX_HASH is not a transaction hash.");
    }
    const receipt = await hre.ethers.provider.getTransactionReceipt(executionHash);
    if (!receipt || receipt.status !== 1) {
      throw new Error("Direct Safe handoff transaction is missing or unsuccessful.");
    }
    executionTransaction = {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      status: receipt.status,
    };
  }

  const result = {
    verifiedAt: new Date().toISOString(),
    chainId: Number(network.chainId),
    mode: "DIRECT_SAFE_2_OF_3",
    governanceSafe,
    safeOwners,
    safeThreshold: Number(safeThreshold),
    ownership,
    formerTimelock: timelockAddress,
    cancelledOperationId: operationId,
    operationState,
    executionTransaction,
    verified: true,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  console.log(`Governance Safe: ${governanceSafe}`);
  console.log(`Targets verified: ${ownership.length}`);
  console.log(`Former Timelock operation cancelled: ${operationId}`);
  if (executionTransaction) {
    console.log(`Execution transaction: ${executionTransaction.hash}`);
  }
  console.log(`Verification written to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
