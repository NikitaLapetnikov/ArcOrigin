const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const ZERO_ADDRESS = hre.ethers.ZeroAddress;
const planPath = process.env.V6_HANDOFF_PLAN
  ? path.resolve(process.env.V6_HANDOFF_PLAN)
  : path.join(__dirname, "..", "deployment", "v6-governance-handoff.local.json");
const outputPath = path.join(__dirname, "..", "deployment", "v6-safe-proposal.local.json");
const serviceBaseUrl =
  process.env.SAFE_TRANSACTION_SERVICE_URL
  ?? "https://api.safe.global/tx-service/arc-testnet";
const safeAbi = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns (bytes32)",
];

async function main() {
  if (!fs.existsSync(planPath)) throw new Error(`Missing V6 handoff plan: ${planPath}`);
  if (fs.existsSync(outputPath)) throw new Error(`Refusing to overwrite Safe proposal: ${outputPath}`);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const [signer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const safe = new hre.ethers.Contract(plan.governanceSafe, safeAbi, signer);
  const owners = await safe.getOwners();
  if (!owners.some((owner) => owner.toLowerCase() === signer.address.toLowerCase())) {
    throw new Error("Connected signer is not an owner of the Governance Safe.");
  }
  if (owners.length !== 3 || await safe.getThreshold() !== 2n) {
    throw new Error("Governance Safe must remain exactly 2-of-3.");
  }
  const nonce = await safe.nonce();
  const safeTransaction = {
    to: hre.ethers.getAddress(plan.safeScheduleTransaction.to),
    value: 0n,
    data: plan.safeScheduleTransaction.data,
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
  const domain = {
    chainId: network.chainId,
    verifyingContract: plan.governanceSafe,
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
  const typedHash = hre.ethers.TypedDataEncoder.hash(domain, types, safeTransaction);
  if (typedHash.toLowerCase() !== safeTxHash.toLowerCase()) {
    throw new Error(`Safe typed-data hash mismatch: ${typedHash} != ${safeTxHash}`);
  }
  const signature = await signer.signTypedData(domain, types, safeTransaction);
  const body = {
    safe: plan.governanceSafe,
    to: safeTransaction.to,
    value: safeTransaction.value.toString(),
    data: safeTransaction.data,
    operation: safeTransaction.operation,
    gasToken: safeTransaction.gasToken,
    safeTxGas: safeTransaction.safeTxGas.toString(),
    baseGas: safeTransaction.baseGas.toString(),
    gasPrice: safeTransaction.gasPrice.toString(),
    refundReceiver: safeTransaction.refundReceiver,
    nonce: Number(safeTransaction.nonce),
    contractTransactionHash: safeTxHash,
    sender: signer.address,
    signature,
    origin: JSON.stringify({ name: "ArcOrigin V6 governance handoff" }),
  };
  const response = await fetch(
    `${serviceBaseUrl}/api/v1/safes/${plan.governanceSafe}/multisig-transactions/`,
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
    safe: plan.governanceSafe,
    safeTxHash,
    nonce: Number(nonce),
    proposer: signer.address,
    to: safeTransaction.to,
    operationId: plan.operationId,
    confirmationsRequired: 2,
    confirmationsSubmitted: 1,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(proposal, null, 2)}\n`);
  console.log(JSON.stringify(proposal, null, 2));
  console.log("Safe schedule transaction proposed. A second owner must confirm and execute it.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
