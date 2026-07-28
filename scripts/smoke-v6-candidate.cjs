const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

const USDC = 10n ** 6n;
const LAUNCH_FEE = 10n * USDC;
const BUY_AMOUNT = 3n * USDC;
const candidatePath = process.env.V6_MANIFEST
  ? path.resolve(process.env.V6_MANIFEST)
  : path.join(__dirname, "..", "deployment", "arcTestnet-v6.local.json");
const outputPath = path.join(__dirname, "..", "deployment", "v6-smoke.local.json");
const erc20Abi = [
  "function approve(address spender,uint256 amount) returns (bool)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getReceipt(hash) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const receipt = await hre.ethers.provider.getTransactionReceipt(hash);
      if (receipt) return receipt;
    } catch (error) {
      lastError = error;
    }
    await wait(500);
  }
  throw lastError ?? new Error(`Receipt not found for ${hash}.`);
}

async function send(transactionPromise, label) {
  const transaction = await transactionPromise;
  console.log(`${label}: ${transaction.hash}`);
  const receipt = await getReceipt(transaction.hash);
  if (receipt.status !== 1) throw new Error(`${label} reverted.`);
  return receipt;
}

async function approveIfNeeded(token, owner, spender, amount, label) {
  if (await token.allowance(owner, spender) >= amount) return null;
  const receipt = await send(token.approve(spender, amount), label);
  return receipt.hash;
}

async function main() {
  if (!fs.existsSync(candidatePath)) throw new Error(`Missing V6 manifest: ${candidatePath}`);
  if (fs.existsSync(outputPath)) throw new Error(`Refusing to overwrite existing smoke manifest: ${outputPath}`);
  const manifest = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  if (manifest.status !== "V6_CANDIDATE_DEPLOYED_REQUIRES_GOVERNANCE_HANDOFF") {
    throw new Error(`Unexpected candidate status: ${manifest.status}`);
  }
  const [creator] = await hre.ethers.getSigners();
  if (creator.address.toLowerCase() !== manifest.deployer.toLowerCase()) {
    throw new Error("Smoke signer must be the V6 candidate deployer.");
  }
  const factory = await hre.ethers.getContractAt("ArcForgeFactoryV6", manifest.contracts.factory, creator);
  const usdc = new hre.ethers.Contract(manifest.contracts.usdc, erc20Abi, creator);
  if (await usdc.balanceOf(creator.address) < LAUNCH_FEE + BUY_AMOUNT) {
    throw new Error("Smoke signer needs at least 13 testnet USDC.");
  }

  const transactions = {};
  transactions.launchApproval = await approveIfNeeded(
    usdc,
    creator.address,
    manifest.contracts.factory,
    LAUNCH_FEE,
    "Approve V6 launch fee",
  );
  const launchReceipt = await send(factory.launchToken({
    name: "ArcOrigin V6 Candidate",
    symbol: "AOV6",
    metadataURI: "ipfs://arcorigin-v6-candidate-smoke",
  }), "Launch V6 smoke token");
  transactions.launch = launchReceipt.hash;
  const launched = launchReceipt.logs
    .map((log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((event) => event?.name === "TokenLaunched");
  if (!launched) throw new Error("TokenLaunched event is missing.");
  const tokenAddress = launched.args.token;
  const curveAddress = launched.args.curve;
  const token = new hre.ethers.Contract(tokenAddress, erc20Abi, creator);
  const curve = await hre.ethers.getContractAt("ArcForgeBondingCurveV6", curveAddress, creator);

  transactions.buyApproval = await approveIfNeeded(
    usdc,
    creator.address,
    curveAddress,
    BUY_AMOUNT,
    "Approve V6 smoke buy",
  );
  const [tokensOut] = await curve.quoteBuy(BUY_AMOUNT);
  if (tokensOut === 0n) throw new Error("V6 smoke buy quote is zero.");
  const latestBlock = await hre.ethers.provider.getBlock("latest");
  const buyReceipt = await send(
    curve.buy(BUY_AMOUNT, tokensOut * 99n / 100n, BigInt(latestBlock.timestamp) + 600n),
    "Execute V6 smoke buy",
  );
  transactions.buy = buyReceipt.hash;
  const tokenBalance = await token.balanceOf(creator.address);
  if (tokenBalance === 0n) throw new Error("V6 smoke buy produced no token balance.");

  const sellAmount = tokenBalance / 2n;
  transactions.sellApproval = await approveIfNeeded(
    token,
    creator.address,
    curveAddress,
    sellAmount,
    "Approve V6 smoke sell",
  );
  const [usdcOut] = await curve.quoteSell(sellAmount);
  if (usdcOut === 0n) throw new Error("V6 smoke sell quote is zero.");
  const sellBlock = await hre.ethers.provider.getBlock("latest");
  const sellReceipt = await send(
    curve.sell(sellAmount, usdcOut * 99n / 100n, BigInt(sellBlock.timestamp) + 600n),
    "Execute V6 smoke sell",
  );
  transactions.sell = sellReceipt.hash;

  const claimableBefore = await curve.claimableCreatorFees();
  if (claimableBefore === 0n) throw new Error("V6 smoke creator fees did not accrue.");
  const claimReceipt = await send(
    curve.claimCreatorFees(creator.address),
    "Claim V6 smoke creator fees",
  );
  transactions.claimCreatorFees = claimReceipt.hash;
  if (await curve.claimableCreatorFees() !== 0n) {
    throw new Error("V6 creator fee claim did not clear accrued accounting.");
  }
  const vault = await hre.ethers.getContractAt("ArcForgeFeeVaultV6", manifest.contracts.feeVault);
  const launchFeeType = await factory.LAUNCH_FEE();
  const buyFeeType = await curve.BUY_FEE();
  const sellFeeType = await curve.SELL_FEE();
  const launchFeesRecorded = await vault.getFeeTotal(manifest.contracts.usdc, launchFeeType);
  const protocolFeesRecorded =
    await vault.getFeeTotal(manifest.contracts.usdc, buyFeeType)
    + await vault.getFeeTotal(manifest.contracts.usdc, sellFeeType);
  if (launchFeesRecorded < LAUNCH_FEE || protocolFeesRecorded === 0n) {
    throw new Error("V6 FeeVault accounting did not record smoke fees.");
  }

  const smoke = {
    verifiedAt: new Date().toISOString(),
    factory: manifest.contracts.factory,
    creator: creator.address,
    token: tokenAddress,
    curve: curveAddress,
    launchBlock: launchReceipt.blockNumber,
    buyAmount: BUY_AMOUNT.toString(),
    tokensReceived: tokenBalance.toString(),
    sellAmount: sellAmount.toString(),
    creatorFeesClaimed: claimableBefore.toString(),
    launchFeesRecorded: launchFeesRecorded.toString(),
    protocolFeesRecorded: protocolFeesRecorded.toString(),
    graduated: await curve.isGraduated(),
    migrationPaused: await factory.migrationPaused(),
    transactions,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(smoke, null, 2)}\n`);
  console.log(`V6 launch/buy/sell/creator-claim smoke passed: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
