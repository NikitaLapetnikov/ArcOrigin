const fs = require("node:fs");
const path = require("node:path");
const {
  concatHex,
  encodeFunctionData,
  encodePacked,
  getAddress,
  hashTypedData,
  size,
} = require("viem");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MULTISEND_CALL_ONLY = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
const DEFAULT_BATCH_PATH = path.join(
  __dirname,
  "..",
  "deployment",
  "arc-mainnet-activation.safe.local.json",
);
const DEFAULT_OUTPUT_PATH = path.join(
  __dirname,
  "..",
  "deployment",
  "arc-mainnet-activation.prepared.local.json",
);
const multiSendAbi = [{
  type: "function",
  name: "multiSend",
  stateMutability: "payable",
  inputs: [{ name: "transactions", type: "bytes" }],
  outputs: [],
}];

function requiredSafeNonce() {
  const value = process.env.SAFE_NONCE?.trim();
  if (!value || !/^\d+$/.test(value)) {
    throw new Error("SAFE_NONCE must be the current non-negative Safe nonce.");
  }
  return BigInt(value);
}

function encodeTransaction(transaction) {
  const to = getAddress(transaction.to);
  const value = BigInt(transaction.value);
  const data = transaction.data;
  return encodePacked(
    ["uint8", "address", "uint256", "uint256", "bytes"],
    [0, to, value, BigInt(size(data)), data],
  );
}

function main() {
  const batchPath = process.env.ACTIVATION_BATCH
    ? path.resolve(process.env.ACTIVATION_BATCH)
    : DEFAULT_BATCH_PATH;
  const outputPath = process.env.ACTIVATION_PREPARED_OUTPUT
    ? path.resolve(process.env.ACTIVATION_PREPARED_OUTPUT)
    : DEFAULT_OUTPUT_PATH;
  const batch = JSON.parse(fs.readFileSync(batchPath, "utf8"));
  const safe = getAddress(batch.meta?.createdFromSafeAddress);
  const chainId = BigInt(batch.chainId);
  const nonce = requiredSafeNonce();

  if (chainId !== 5_042n) throw new Error("Activation batch must target Arc mainnet.");
  if (!Array.isArray(batch.transactions) || batch.transactions.length === 0) {
    throw new Error("Activation batch contains no transactions.");
  }

  const packedTransactions = concatHex(batch.transactions.map(encodeTransaction));
  const data = encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packedTransactions] });
  const safeTransaction = {
    to: MULTISEND_CALL_ONLY,
    value: 0n,
    data,
    operation: 1,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  };
  const types = {
    SafeTx: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
  };
  const safeTxHash = hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types,
    primaryType: "SafeTx",
    message: safeTransaction,
  });
  const output = {
    preparedAt: new Date().toISOString(),
    chainId: Number(chainId),
    safe,
    safeTxHash,
    nonce: Number(nonce),
    transaction: {
      ...safeTransaction,
      value: safeTransaction.value.toString(),
      safeTxGas: safeTransaction.safeTxGas.toString(),
      baseGas: safeTransaction.baseGas.toString(),
      gasPrice: safeTransaction.gasPrice.toString(),
      nonce: safeTransaction.nonce.toString(),
    },
    packedTransactions,
    transactions: batch.transactions.map((transaction) => ({
      to: getAddress(transaction.to),
      value: BigInt(transaction.value).toString(),
      data: transaction.data,
    })),
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({
    safe,
    safeTxHash,
    nonce: Number(nonce),
    operationCount: batch.transactions.length,
    multiSendCallOnly: MULTISEND_CALL_ONLY,
    outputPath,
  }, null, 2));
}

main();
