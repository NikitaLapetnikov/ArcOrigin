const hre = require("hardhat");

const timelockAbi = [
  "function getMinDelay() view returns (uint256)",
  "function hashOperation(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) view returns (bytes32)",
  "function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)",
  "function execute(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt) payable",
];

function requiredAddress(name) {
  const value = process.env[name];
  if (!value || !hre.ethers.isAddress(value) || value === hre.ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero address.`);
  }
  return hre.ethers.getAddress(value);
}

async function main() {
  const timelockAddress = requiredAddress("GOVERNANCE_TIMELOCK");
  const target = requiredAddress("TIMELOCK_TARGET");
  const data = process.env.TIMELOCK_CALLDATA;
  if (!data || !hre.ethers.isHexString(data) || hre.ethers.dataLength(data) < 4) {
    throw new Error("TIMELOCK_CALLDATA must be hex calldata containing a function selector.");
  }
  const value = BigInt(process.env.TIMELOCK_VALUE_WEI ?? "0");
  if (value < 0n) throw new Error("TIMELOCK_VALUE_WEI cannot be negative.");
  const saltLabel = process.env.TIMELOCK_SALT_LABEL;
  if (!saltLabel || saltLabel.trim().length < 8) {
    throw new Error("TIMELOCK_SALT_LABEL must describe the operation and contain at least 8 characters.");
  }
  for (const [label, address] of [["timelock", timelockAddress], ["target", target]]) {
    if (await hre.ethers.provider.getCode(address) === "0x") {
      throw new Error(`${label} has no deployed contract code at ${address}.`);
    }
  }

  const timelock = new hre.ethers.Contract(timelockAddress, timelockAbi, hre.ethers.provider);
  const delay = await timelock.getMinDelay();
  const predecessor = hre.ethers.ZeroHash;
  const salt = hre.ethers.id(saltLabel.trim());
  const operationId = await timelock.hashOperation(target, value, data, predecessor, salt);
  const scheduleCalldata = timelock.interface.encodeFunctionData("schedule", [
    target,
    value,
    data,
    predecessor,
    salt,
    delay,
  ]);
  const executeCalldata = timelock.interface.encodeFunctionData("execute", [
    target,
    value,
    data,
    predecessor,
    salt,
  ]);

  console.log(JSON.stringify({
    timelock: timelockAddress,
    target,
    value: value.toString(),
    data,
    saltLabel: saltLabel.trim(),
    salt,
    predecessor,
    minimumDelaySeconds: delay.toString(),
    operationId,
    safeScheduleTransaction: {
      to: timelockAddress,
      value: "0",
      data: scheduleCalldata,
    },
    permissionlessExecuteTransaction: {
      to: timelockAddress,
      value: value.toString(),
      data: executeCalldata,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
