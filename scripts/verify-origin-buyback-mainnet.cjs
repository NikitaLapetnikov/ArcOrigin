const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const deploymentPath = path.join(
  __dirname,
  "..",
  "deployment",
  "origin-buyback-mainnet.local.json",
);
const proposalPath = path.join(
  __dirname,
  "..",
  "deployment",
  "origin-buyback-safe-proposal.local.json",
);
const outputPath = path.join(
  __dirname,
  "..",
  "deployment",
  "origin-buyback-activation.local.json",
);
const safeTransactionService = "https://api.safe.global/tx-service/arc";
const feeVaultAbi = [
  "function owner() view returns (address)",
  "function feeRecipient() view returns (address)",
];
const controllerAbi = [
  "function owner() view returns (address)",
  "function emergencyGuardian() view returns (address)",
  "function operationsRecipient() view returns (address)",
  "function isExecutor(address) view returns (bool)",
  "function usdc() view returns (address)",
  "function protocolToken() view returns (address)",
  "function curve() view returns (address)",
  "function BUYBACK_SHARE_BPS() view returns (uint16)",
  "function maxChunkUsdc() view returns (uint256)",
  "function executionInterval() view returns (uint64)",
  "function maxSlippageBps() view returns (uint16)",
  "function paused() view returns (bool)",
];

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

async function main() {
  if (!fs.existsSync(deploymentPath) || !fs.existsSync(proposalPath)) {
    throw new Error("ORIGIN buyback deployment and Safe proposal records are required.");
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const proposal = JSON.parse(fs.readFileSync(proposalPath, "utf8"));
  const network = await hre.ethers.provider.getNetwork();
  assertEqual("chain ID", network.chainId, 5_042n);

  const response = await fetch(
    `${safeTransactionService}/api/v1/multisig-transactions/${proposal.safeTxHash}/`,
  );
  if (!response.ok) {
    throw new Error(`Safe Transaction Service lookup failed (${response.status}).`);
  }
  const safeTransaction = await response.json();
  if (!safeTransaction.isExecuted || safeTransaction.isSuccessful !== true) {
    throw new Error("Safe activation transaction has not executed successfully.");
  }
  assertEqual("Safe transaction target", safeTransaction.to, deployment.feeVault);
  assertEqual("Safe transaction calldata", safeTransaction.data, deployment.governanceAction.calldata);

  const feeVault = new hre.ethers.Contract(
    deployment.feeVault,
    feeVaultAbi,
    hre.ethers.provider,
  );
  const controller = new hre.ethers.Contract(
    deployment.controller,
    controllerAbi,
    hre.ethers.provider,
  );
  const [
    vaultOwner,
    feeRecipient,
    controllerOwner,
    guardian,
    operationsRecipient,
    executorAllowed,
    usdc,
    protocolToken,
    curve,
    buybackShareBps,
    maxChunkUsdc,
    executionInterval,
    maxSlippageBps,
    paused,
  ] = await Promise.all([
    feeVault.owner(),
    feeVault.feeRecipient(),
    controller.owner(),
    controller.emergencyGuardian(),
    controller.operationsRecipient(),
    controller.isExecutor(deployment.executor),
    controller.usdc(),
    controller.protocolToken(),
    controller.curve(),
    controller.BUYBACK_SHARE_BPS(),
    controller.maxChunkUsdc(),
    controller.executionInterval(),
    controller.maxSlippageBps(),
    controller.paused(),
  ]);

  assertEqual("FeeVault owner", vaultOwner, deployment.owner);
  assertEqual("FeeVault recipient", feeRecipient, deployment.controller);
  assertEqual("controller owner", controllerOwner, deployment.owner);
  assertEqual("controller guardian", guardian, deployment.emergencyGuardian);
  assertEqual("operations recipient", operationsRecipient, deployment.operationsRecipient);
  assertEqual("executor authorization", executorAllowed, true);
  assertEqual("USDC", usdc, deployment.usdc);
  assertEqual("ORIGIN token", protocolToken, deployment.token);
  assertEqual("ORIGIN curve", curve, deployment.curve);
  assertEqual("buyback share", buybackShareBps, deployment.config.buybackShareBps);
  assertEqual("max chunk", maxChunkUsdc, deployment.config.maxChunkUsdcRaw);
  assertEqual("execution interval", executionInterval, deployment.config.executionIntervalSeconds);
  assertEqual("max slippage", maxSlippageBps, deployment.config.maxSlippageBps);
  assertEqual("paused", paused, false);

  const verification = {
    network: deployment.network,
    chainId: deployment.chainId,
    status: "ACTIVE",
    token: deployment.token,
    curve: deployment.curve,
    controller: deployment.controller,
    feeVault: deployment.feeVault,
    governanceSafe: deployment.owner,
    executor: deployment.executor,
    activationSafeTxHash: proposal.safeTxHash,
    activationTransaction: safeTransaction.transactionHash,
    activatedAt: safeTransaction.executionDate,
    verifiedAt: new Date().toISOString(),
    policy: deployment.config,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(verification, null, 2)}\n`);
  console.log(JSON.stringify(verification, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
