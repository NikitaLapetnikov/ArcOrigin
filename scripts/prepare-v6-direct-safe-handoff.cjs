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
const outputPath = process.env.V6_DIRECT_SAFE_OUTPUT
  ? path.resolve(process.env.V6_DIRECT_SAFE_OUTPUT)
  : path.join(
    __dirname,
    "..",
    "deployment",
    "v6-mainnet-direct-safe-handoff.local.json",
  );
const safeBatchOutputPath = process.env.V6_DIRECT_SAFE_BATCH_OUTPUT
  ? path.resolve(process.env.V6_DIRECT_SAFE_BATCH_OUTPUT)
  : path.join(
    __dirname,
    "..",
    "deployment",
    "v6-mainnet-direct-safe-batch.local.json",
  );

const ownableAbi = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
];
const timelockAbi = [
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
  "function isOperation(bytes32 id) view returns (bool)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function cancel(bytes32 id)",
];
const safeAbi = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
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

async function requireTwoOfThreeSafe(address) {
  await requireContract("Governance Safe", address);
  const safe = new hre.ethers.Contract(address, safeAbi, hre.ethers.provider);
  const owners = await safe.getOwners();
  const threshold = await safe.getThreshold();
  if (threshold !== 2n || owners.length !== 3) {
    throw new Error("Governance Safe must be exactly 2-of-3.");
  }
  if (new Set(owners.map((owner) => owner.toLowerCase())).size !== 3) {
    throw new Error("Governance Safe contains duplicate owners.");
  }
  return owners;
}

function safeTransaction(to, data) {
  return {
    to,
    value: "0",
    data,
    contractMethod: null,
    contractInputsValues: null,
  };
}

async function readOwnership(targets) {
  return Promise.all(
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
  assertEqual("timelock plan chain ID", timelockPlan.chainId, manifest.chainId);

  const deployer = hre.ethers.getAddress(manifest.deployer);
  const governanceSafe = hre.ethers.getAddress(manifest.governance.safe);
  const timelockAddress = hre.ethers.getAddress(manifest.governance.timelock);
  const operationId = timelockPlan.operationId;
  assertEqual("plan governance Safe", timelockPlan.governanceSafe, governanceSafe);
  assertEqual("plan Timelock", timelockPlan.timelock, timelockAddress);

  const safeOwners = await requireTwoOfThreeSafe(governanceSafe);
  await requireContract("Governance Timelock", timelockAddress);

  const targets = [
    { label: "V6 Factory", address: manifest.contracts.factory },
    { label: "V6 FeeVault", address: manifest.contracts.feeVault },
    { label: "V6 CreatorRegistry", address: manifest.contracts.creatorRegistry },
  ].map((target) => ({
    label: target.label,
    address: hre.ethers.getAddress(target.address),
  }));
  for (const target of targets) {
    await requireContract(target.label, target.address);
  }

  const timelock = new hre.ethers.Contract(
    timelockAddress,
    timelockAbi,
    hre.ethers.provider,
  );
  const cancellerRole = await timelock.CANCELLER_ROLE();
  if (!(await timelock.hasRole(cancellerRole, governanceSafe))) {
    throw new Error("Governance Safe does not have the Timelock canceller role.");
  }
  const [isOperation, isPending, isReady, isDone] = await Promise.all([
    timelock.isOperation(operationId),
    timelock.isOperationPending(operationId),
    timelock.isOperationReady(operationId),
    timelock.isOperationDone(operationId),
  ]);
  if (isDone) {
    throw new Error("Timelock ownership handoff has already executed.");
  }
  if (!isOperation || (!isPending && !isReady)) {
    throw new Error("Reviewed Timelock ownership handoff is not cancellable.");
  }

  const ownershipBefore = await readOwnership(targets);
  for (const target of ownershipBefore) {
    if (!sameAddress(target.owner, deployer)) {
      throw new Error(`${target.label} is no longer owned by the reviewed deployer.`);
    }
    if (
      target.pendingOwner !== ZERO_ADDRESS &&
      !sameAddress(target.pendingOwner, timelockAddress) &&
      !sameAddress(target.pendingOwner, governanceSafe)
    ) {
      throw new Error(`${target.label} has an unexpected pending owner.`);
    }
  }

  const ownableInterface = new hre.ethers.Interface(ownableAbi);
  const transferTransactions = targets.map((target) =>
    safeTransaction(
      target.address,
      ownableInterface.encodeFunctionData("transferOwnership", [governanceSafe]),
    ),
  );
  const safeBatchTransactions = [
    safeTransaction(
      timelockAddress,
      timelock.interface.encodeFunctionData("cancel", [operationId]),
    ),
    ...targets.map((target) =>
      safeTransaction(
        target.address,
        ownableInterface.encodeFunctionData("acceptOwnership"),
      ),
    ),
  ];

  const executeTransfers = process.env.EXECUTE_DIRECT_SAFE_TRANSFERS === "true";
  if (executeTransfers) {
    if (process.env.CONFIRM_DIRECT_SAFE !== governanceSafe) {
      throw new Error(
        "CONFIRM_DIRECT_SAFE must equal the exact reviewed Governance Safe.",
      );
    }
    const [signer] = await hre.ethers.getSigners();
    if (!signer || !sameAddress(signer.address, deployer)) {
      throw new Error("Connected signer must be the reviewed mainnet deployer.");
    }
    if ((await hre.ethers.provider.getBalance(signer.address)) === 0n) {
      throw new Error("Mainnet deployer has no native USDC for gas.");
    }

    for (const target of targets) {
      const contract = new hre.ethers.Contract(target.address, ownableAbi, signer);
      const owner = await contract.owner();
      const pendingOwner = await contract.pendingOwner();
      if (!sameAddress(owner, deployer)) {
        throw new Error(`${target.label} owner changed before preparation.`);
      }
      if (sameAddress(pendingOwner, governanceSafe)) {
        console.log(`${target.label}: Governance Safe is already pending owner.`);
        continue;
      }
      const transaction = await contract.transferOwnership(governanceSafe);
      console.log(`${target.label} transferOwnership: ${transaction.hash}`);
      const receipt = await transaction.wait();
      if (!receipt || receipt.status !== 1) {
        throw new Error(`${target.label} transferOwnership reverted.`);
      }
      if (!sameAddress(await contract.pendingOwner(), governanceSafe)) {
        throw new Error(`${target.label} pending owner verification failed.`);
      }
    }
  }

  const ownershipAfterPreparation = await readOwnership(targets);
  const prepared = ownershipAfterPreparation.every(
    (target) =>
      sameAddress(target.owner, deployer) &&
      sameAddress(target.pendingOwner, governanceSafe),
  );
  const output = {
    createdAt: new Date().toISOString(),
    chainId: Number(network.chainId),
    mode: "DIRECT_SAFE_2_OF_3",
    deployer,
    governanceSafe,
    safeOwners,
    timelock: timelockAddress,
    cancelledTimelockOperation: operationId,
    targets,
    ownershipBefore,
    ownershipAfterPreparation,
    deployerTransferTransactions: transferTransactions,
    safeBatch: {
      version: "1.0",
      chainId: String(network.chainId),
      createdAt: Date.now(),
      meta: {
        name: "ArcOrigin V6 direct Safe ownership",
        description:
          "Cancel the delayed Timelock handoff and atomically accept V6 ownership in the 2-of-3 Safe.",
      },
      transactions: safeBatchTransactions,
    },
    prepared,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  fs.writeFileSync(
    safeBatchOutputPath,
    `${JSON.stringify(output.safeBatch, null, 2)}\n`,
  );

  console.log(`Mode: ${executeTransfers ? "PREPARE DIRECT SAFE" : "DRY RUN"}`);
  console.log(`Governance Safe: ${governanceSafe}`);
  console.log(`Timelock operation: ${operationId}`);
  console.log(`Prepared: ${prepared}`);
  console.log(`Plan written to ${outputPath}`);
  console.log(`Safe batch written to ${safeBatchOutputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
