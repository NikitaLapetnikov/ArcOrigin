const fs = require("node:fs");
const path = require("node:path");
const { createPublicClient, getAddress, http, keccak256 } = require("viem");

const DEFAULT_PREPARED_PATH = path.join(
  __dirname,
  "..",
  "deployment",
  "arc-mainnet-activation.prepared.local.json",
);
const safeAbi = [{
  type: "function",
  name: "getTransactionHash",
  stateMutability: "view",
  inputs: [
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
  outputs: [{ name: "", type: "bytes32" }],
}];

async function main() {
  const rpcUrl = process.env.ARC_MAINNET_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("ARC_MAINNET_RPC_URL is required.");
  const preparedPath = process.env.ACTIVATION_PREPARED
    ? path.resolve(process.env.ACTIVATION_PREPARED)
    : DEFAULT_PREPARED_PATH;
  const prepared = JSON.parse(fs.readFileSync(preparedPath, "utf8"));
  const transaction = prepared.transaction;
  const client = createPublicClient({ transport: http(rpcUrl) });

  const [chainId, nonce, owners, threshold, multiSendCode, onchainSafeTxHash] = await Promise.all([
    client.getChainId(),
    client.readContract({ address: prepared.safe, abi: [{
      type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }],
    }], functionName: "nonce" }),
    client.readContract({ address: prepared.safe, abi: [{
      type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }],
    }], functionName: "getOwners" }),
    client.readContract({ address: prepared.safe, abi: [{
      type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }],
    }], functionName: "getThreshold" }),
    client.getCode({ address: transaction.to }),
    client.readContract({
      address: prepared.safe,
      abi: safeAbi,
      functionName: "getTransactionHash",
      args: [
        transaction.to,
        BigInt(transaction.value),
        transaction.data,
        transaction.operation,
        BigInt(transaction.safeTxGas),
        BigInt(transaction.baseGas),
        BigInt(transaction.gasPrice),
        transaction.gasToken,
        transaction.refundReceiver,
        BigInt(transaction.nonce),
      ],
    }),
  ]);

  if (chainId !== 5_042) throw new Error(`Unexpected chain ID ${chainId}.`);
  if (nonce !== BigInt(prepared.nonce)) throw new Error(`Safe nonce changed to ${nonce}.`);
  if (threshold !== 2n || owners.length !== 3) throw new Error("Safe is not exactly 2-of-3.");
  if (!multiSendCode || multiSendCode === "0x") throw new Error("MultiSendCallOnly has no code.");
  if (onchainSafeTxHash.toLowerCase() !== prepared.safeTxHash.toLowerCase()) {
    throw new Error(`Safe hash mismatch: ${onchainSafeTxHash} != ${prepared.safeTxHash}`);
  }

  console.log(JSON.stringify({
    chainId,
    safe: getAddress(prepared.safe),
    nonce: Number(nonce),
    threshold: Number(threshold),
    owners: owners.map(getAddress),
    multiSendCallOnly: getAddress(transaction.to),
    multiSendCodeHash: keccak256(multiSendCode),
    safeTxHash: onchainSafeTxHash,
    operationCount: prepared.transactions.length,
    verified: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
