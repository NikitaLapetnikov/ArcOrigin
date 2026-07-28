const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_CHAIN_ID = 5_042_002n;
const ZERO_ADDRESS = hre.ethers.ZeroAddress;
const ZERO_HASH = hre.ethers.ZeroHash;
const planPath = process.env.V6_HANDOFF_PLAN
  ? path.resolve(process.env.V6_HANDOFF_PLAN)
  : path.join(__dirname, "..", "deployment", "v6-governance-handoff.local.json");
const outputPath = path.join(
  __dirname,
  "..",
  "deployment",
  "v6-governance-handoff-execution.local.json",
);
const ownableAbi = [
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
];
const timelockAbi = [
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function hashOperationBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt) view returns (bytes32)",
  "function isOperation(bytes32 id) view returns (bool)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function executeBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt) payable",
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

async function readOwnership(targets) {
  return Promise.all(
    targets.map(async (target) => {
      const contract = new hre.ethers.Contract(
        target.address,
        ownableAbi,
        hre.ethers.provider,
      );
      return {
        label: target.label,
        address: target.address,
        owner: await contract.owner(),
        pendingOwner: await contract.pendingOwner(),
      };
    }),
  );
}

function assertOwnershipState(ownership, timelock, completed) {
  for (const target of ownership) {
    if (completed) {
      assertEqual(`${target.label} owner`, target.owner, timelock);
      assertEqual(`${target.label} pending owner`, target.pendingOwner, ZERO_ADDRESS);
      continue;
    }
    if (
      sameAddress(target.owner, timelock) ||
      !sameAddress(target.pendingOwner, timelock)
    ) {
      throw new Error(
        `${target.label} has an unexpected pre-execution ownership state.`,
      );
    }
  }
}

async function main() {
  if (!fs.existsSync(planPath)) {
    throw new Error(`V6 handoff plan not found at ${planPath}.`);
  }
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, EXPECTED_CHAIN_ID);
  await requireContract("Governance Timelock", plan.timelock);
  for (const target of plan.targets) {
    await requireContract(target.label, target.address);
  }

  const timelock = new hre.ethers.Contract(
    plan.timelock,
    timelockAbi,
    hre.ethers.provider,
  );
  const decoded = timelock.interface.decodeFunctionData(
    "executeBatch",
    plan.permissionlessExecuteAfterDelay.data,
  );
  const targets = Array.from(decoded[0]);
  const values = Array.from(decoded[1]);
  const payloads = Array.from(decoded[2]);
  const predecessor = decoded[3];
  const salt = decoded[4];
  assertEqual("execution target", plan.permissionlessExecuteAfterDelay.to, plan.timelock);
  assertEqual("execution value", plan.permissionlessExecuteAfterDelay.value, "0");
  assertEqual("predecessor", predecessor, ZERO_HASH);
  assertEqual("salt", salt, plan.salt);
  if (targets.length !== plan.targets.length) {
    throw new Error("Execution target count does not match the reviewed handoff plan.");
  }
  for (let index = 0; index < targets.length; index += 1) {
    assertEqual(
      `${plan.targets[index].label} execution address`,
      targets[index],
      plan.targets[index].address,
    );
    assertEqual(`${plan.targets[index].label} execution value`, values[index], 0n);
    assertEqual(`${plan.targets[index].label} payload`, payloads[index], "0x79ba5097");
  }

  const operationId = await timelock.hashOperationBatch(
    targets,
    values,
    payloads,
    predecessor,
    salt,
  );
  assertEqual("operation ID", operationId, plan.operationId);
  const [isOperation, isPending, isReady, isDone, timestamp] = await Promise.all([
    timelock.isOperation(operationId),
    timelock.isOperationPending(operationId),
    timelock.isOperationReady(operationId),
    timelock.isOperationDone(operationId),
    timelock.getTimestamp(operationId),
  ]);
  const ownershipBefore = await readOwnership(plan.targets);

  console.log(`Operation: ${operationId}`);
  console.log(`Timelock: ${plan.timelock}`);
  if (isDone) {
    assertOwnershipState(ownershipBefore, plan.timelock, true);
    console.log("V6 ownership handoff is already complete and verified.");
    return;
  }
  if (!isOperation || (!isPending && !isReady)) {
    throw new Error("The reviewed V6 handoff operation is not scheduled.");
  }
  assertOwnershipState(ownershipBefore, plan.timelock, false);

  const readyAt = new Date(Number(timestamp) * 1_000);
  console.log(`Ready at: ${readyAt.toISOString()}`);
  console.log(`State: ${isReady ? "READY" : "WAITING"}`);
  const execute = process.env.EXECUTE_V6_HANDOFF_FINAL === "true";
  if (!execute) {
    console.log(
      isReady
        ? "Dry run complete. Set EXECUTE_V6_HANDOFF_FINAL=true with the exact confirmation value to execute."
        : "Dry run complete. No transaction can be sent before the timelock is ready.",
    );
    return;
  }
  if (!isReady) {
    throw new Error(`Timelock is not ready until ${readyAt.toISOString()}.`);
  }
  if (process.env.CONFIRM_V6_HANDOFF_OPERATION !== operationId) {
    throw new Error(
      "CONFIRM_V6_HANDOFF_OPERATION must equal the exact reviewed operation ID.",
    );
  }

  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("A funded executor signer is required.");
  const signerBalance = await hre.ethers.provider.getBalance(signer.address);
  if (signerBalance === 0n) {
    throw new Error(`Executor ${signer.address} has no native gas balance.`);
  }
  console.log(`Permissionless executor: ${signer.address}`);
  const transaction = await timelock
    .connect(signer)
    .executeBatch(targets, values, payloads, predecessor, salt);
  console.log(`Execution transaction: ${transaction.hash}`);
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error("V6 ownership handoff transaction reverted.");
  }

  if (!(await timelock.isOperationDone(operationId))) {
    throw new Error("Timelock did not mark the V6 handoff operation as done.");
  }
  const ownershipAfter = await readOwnership(plan.targets);
  assertOwnershipState(ownershipAfter, plan.timelock, true);
  const execution = {
    executedAt: new Date().toISOString(),
    chainId: Number(EXPECTED_CHAIN_ID),
    operationId,
    timelock: plan.timelock,
    executor: signer.address,
    transactionHash: transaction.hash,
    blockNumber: receipt.blockNumber,
    targets: ownershipAfter,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(execution, null, 2)}\n`);
  console.log(`Verified execution record written to ${outputPath}.`);
  console.log("V6 Factory, FeeVault, and CreatorRegistry are now owned by the Timelock.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
