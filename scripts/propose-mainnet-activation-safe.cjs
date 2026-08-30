const fs = require("node:fs");
const path = require("node:path");
const { getAddress, recoverTypedDataAddress } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");

const SAFE_SERVICE_URL = "https://api.safe.global/tx-service/arc";
const DEFAULT_PREPARED_PATH = path.join(
  __dirname,
  "..",
  "deployment",
  "arc-mainnet-activation.prepared.local.json",
);
const DEFAULT_OUTPUT_PATH = path.join(
  __dirname,
  "..",
  "deployment",
  "arc-mainnet-activation.proposal.local.json",
);
const safeTxTypes = {
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

async function main() {
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!privateKey) throw new Error("DEPLOYER_PRIVATE_KEY is required.");
  const preparedPath = process.env.ACTIVATION_PREPARED
    ? path.resolve(process.env.ACTIVATION_PREPARED)
    : DEFAULT_PREPARED_PATH;
  const outputPath = process.env.ACTIVATION_PROPOSAL_OUTPUT
    ? path.resolve(process.env.ACTIVATION_PROPOSAL_OUTPUT)
    : DEFAULT_OUTPUT_PATH;
  const prepared = JSON.parse(fs.readFileSync(preparedPath, "utf8"));
  const account = privateKeyToAccount(privateKey);
  const expectedOwner = getAddress("0x2807B95E05649b7Befe74C4061f9492C5b889A42");
  if (getAddress(account.address) !== expectedOwner) {
    throw new Error(`Configured signer is not the expected Safe owner: ${account.address}.`);
  }

  const transaction = prepared.transaction;
  const domain = { chainId: BigInt(prepared.chainId), verifyingContract: prepared.safe };
  const message = {
    to: transaction.to,
    value: BigInt(transaction.value),
    data: transaction.data,
    operation: transaction.operation,
    safeTxGas: BigInt(transaction.safeTxGas),
    baseGas: BigInt(transaction.baseGas),
    gasPrice: BigInt(transaction.gasPrice),
    gasToken: transaction.gasToken,
    refundReceiver: transaction.refundReceiver,
    nonce: BigInt(transaction.nonce),
  };
  const signature = await account.signTypedData({
    domain,
    types: safeTxTypes,
    primaryType: "SafeTx",
    message,
  });
  const recoveredOwner = await recoverTypedDataAddress({
    domain,
    types: safeTxTypes,
    primaryType: "SafeTx",
    message,
    signature,
  });
  if (getAddress(recoveredOwner) !== expectedOwner) {
    throw new Error(`Signature recovered unexpected owner ${recoveredOwner}.`);
  }

  const body = {
    safe: prepared.safe,
    to: transaction.to,
    value: transaction.value,
    data: transaction.data,
    operation: transaction.operation,
    gasToken: transaction.gasToken,
    safeTxGas: transaction.safeTxGas,
    baseGas: transaction.baseGas,
    gasPrice: transaction.gasPrice,
    refundReceiver: transaction.refundReceiver,
    nonce: prepared.nonce,
    contractTransactionHash: prepared.safeTxHash,
    sender: account.address,
    signature,
    origin: JSON.stringify({ name: "ArcOrigin direct Uniswap activation" }),
  };
  const response = await fetch(
    `${SAFE_SERVICE_URL}/api/v1/safes/${prepared.safe}/multisig-transactions/`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(`Safe Transaction Service rejected proposal (${response.status}): ${await response.text()}`);
  }

  const proposal = {
    proposedAt: new Date().toISOString(),
    safe: prepared.safe,
    safeTxHash: prepared.safeTxHash,
    nonce: prepared.nonce,
    proposer: getAddress(account.address),
    confirmationsRequired: 2,
    confirmationsSubmitted: 1,
    status: "AWAITING_SECOND_OWNER_CONFIRMATION",
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(proposal, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(proposal, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
