const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ZERO_ADDRESS = hre.ethers.ZeroAddress;
const deploymentPath = path.join(
  __dirname,
  "..",
  "deployment",
  "origin-buyback-mainnet.local.json",
);
const outputPath = path.join(
  __dirname,
  "..",
  "deployment",
  "origin-buyback-safe-proposal.local.json",
);
const serviceBaseUrl = "https://api.safe.global/tx-service/arc";
const safeAbi = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns (bytes32)",
];

async function main() {
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`Missing ORIGIN buyback deployment: ${deploymentPath}`);
  }
  if (fs.existsSync(outputPath)) {
    throw new Error(`Refusing to overwrite Safe proposal: ${outputPath}`);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const [signer] = await hre.ethers.getSigners();
  if (!signer) throw new Error("MAINNET_DEPLOYER_PRIVATE_KEY is required.");
  const network = await hre.ethers.provider.getNetwork();
  if (network.chainId !== 5_042n || deployment.chainId !== 5_042) {
    throw new Error("ORIGIN buyback proposal must be created on Arc mainnet.");
  }

  const safeAddress = hre.ethers.getAddress(deployment.owner);
  const safe = new hre.ethers.Contract(safeAddress, safeAbi, signer);
  const [owners, threshold, nonce] = await Promise.all([
    safe.getOwners(),
    safe.getThreshold(),
    safe.nonce(),
  ]);
  if (!owners.some((owner) => owner.toLowerCase() === signer.address.toLowerCase())) {
    throw new Error("Connected signer is not an owner of the Governance Safe.");
  }
  if (owners.length !== 3 || threshold !== 2n) {
    throw new Error("Governance Safe must remain exactly 2-of-3.");
  }

  const action = deployment.governanceAction;
  const safeTransaction = {
    to: hre.ethers.getAddress(action.target),
    value: BigInt(action.value),
    data: action.calldata,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  };
  const safeTxHash = await safe.getTransactionHash(
    safeTransaction.to,
    safeTransaction.value,
    safeTransaction.data,
    safeTransaction.operation,
    safeTransaction.safeTxGas,
    safeTransaction.baseGas,
    safeTransaction.gasPrice,
    safeTransaction.gasToken,
    safeTransaction.refundReceiver,
    safeTransaction.nonce,
  );
  const domain = { chainId: network.chainId, verifyingContract: safeAddress };
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
  const typedHash = hre.ethers.TypedDataEncoder.hash(domain, types, safeTransaction);
  if (typedHash.toLowerCase() !== safeTxHash.toLowerCase()) {
    throw new Error(`Safe typed-data hash mismatch: ${typedHash} != ${safeTxHash}`);
  }
  const signature = await signer.signTypedData(domain, types, safeTransaction);
  const body = {
    safe: safeAddress,
    to: safeTransaction.to,
    value: safeTransaction.value.toString(),
    data: safeTransaction.data,
    operation: safeTransaction.operation,
    gasToken: safeTransaction.gasToken,
    safeTxGas: safeTransaction.safeTxGas.toString(),
    baseGas: safeTransaction.baseGas.toString(),
    gasPrice: safeTransaction.gasPrice.toString(),
    refundReceiver: safeTransaction.refundReceiver,
    nonce: Number(nonce),
    contractTransactionHash: safeTxHash,
    sender: signer.address,
    signature,
    origin: JSON.stringify({ name: "Activate ORIGIN buyback-and-burn" }),
  };

  const response = await fetch(
    `${serviceBaseUrl}/api/v1/safes/${safeAddress}/multisig-transactions/`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Safe Transaction Service rejected proposal (${response.status}): ${await response.text()}`,
    );
  }

  const proposal = {
    proposedAt: new Date().toISOString(),
    safe: safeAddress,
    safeTxHash,
    nonce: Number(nonce),
    proposer: signer.address,
    to: safeTransaction.to,
    calldata: safeTransaction.data,
    controller: deployment.controller,
    confirmationsRequired: 2,
    confirmationsSubmitted: 1,
    status: "AWAITING_SECOND_OWNER_CONFIRMATION_AND_EXECUTION",
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(proposal, null, 2)}\n`);
  console.log(JSON.stringify(proposal, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
