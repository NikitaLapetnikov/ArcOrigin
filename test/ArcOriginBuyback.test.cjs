const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const USDC = 10n ** 6n;
const LAUNCH_FEE = 10n * USDC;
const VIRTUAL_RESERVE = 2_500n * USDC;
const GRADUATION_THRESHOLD = 10_000n * USDC;
const MAX_CHUNK = 25n * USDC;
const EXECUTION_INTERVAL = 3_600;
const MAX_SLIPPAGE_BPS = 300n;
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

async function futureDeadline(seconds = 600n) {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block.timestamp) + seconds;
}

async function deployProtocolToken() {
  const [
    owner,
    creator,
    funder,
    operations,
    executor,
    guardian,
    stranger,
    alternate,
  ] = await ethers.getSigners();

  const Usdc = await ethers.getContractFactory("MockUSDC");
  const usdc = await Usdc.deploy();
  const Vault = await ethers.getContractFactory("ArcForgeFeeVaultV6");
  const vault = await Vault.deploy(owner.address, operations.address);
  const Registry = await ethers.getContractFactory("ArcForgeCreatorRegistryV6");
  const registry = await Registry.deploy(owner.address);
  const CurveDeployer = await ethers.getContractFactory("ArcForgeCurveDeployerV6");
  const curveDeployer = await CurveDeployer.deploy(owner.address);
  const Factory = await ethers.getContractFactory("ArcForgeFactoryV6");
  const factory = await Factory.deploy(
    owner.address,
    guardian.address,
    await usdc.getAddress(),
    await vault.getAddress(),
    await registry.getAddress(),
    await curveDeployer.getAddress(),
    LAUNCH_FEE,
    VIRTUAL_RESERVE,
    GRADUATION_THRESHOLD,
  );

  const factoryAddress = await factory.getAddress();
  await curveDeployer.bindFactory(factoryAddress);
  await vault.setRegistrar(factoryAddress, true);
  await vault.setCollector(factoryAddress, true);
  await registry.setFactory(factoryAddress);
  await usdc.mint(creator.address, 1_000n * USDC);
  await usdc.mint(funder.address, 1_000_000n * USDC);
  await usdc.connect(creator).approve(factoryAddress, LAUNCH_FEE);

  const launchTransaction = await factory.connect(creator).launchToken({
    name: "ArcOrigin",
    symbol: "AORG",
    metadataURI: "ipfs://aorg",
  });
  const launchReceipt = await launchTransaction.wait();
  const launchEvent = launchReceipt.logs
    .map((log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((event) => event?.name === "TokenLaunched");
  const token = await ethers.getContractAt("ArcForgeToken", launchEvent.args.token);
  const curve = await ethers.getContractAt("ArcForgeBondingCurveV6", launchEvent.args.curve);

  const Controller = await ethers.getContractFactory("ArcOriginBuybackController");
  const controller = await Controller.deploy(
    owner.address,
    guardian.address,
    operations.address,
    executor.address,
    await usdc.getAddress(),
    await token.getAddress(),
    await curve.getAddress(),
    MAX_CHUNK,
    EXECUTION_INTERVAL,
    MAX_SLIPPAGE_BPS,
  );

  return {
    owner,
    creator,
    funder,
    operations,
    executor,
    guardian,
    stranger,
    alternate,
    usdc,
    vault,
    registry,
    curveDeployer,
    factory,
    token,
    curve,
    controller,
  };
}

async function fundAndAllocate(platform, amount = 100n * USDC) {
  const { funder, usdc, controller } = platform;
  await usdc.connect(funder).transfer(await controller.getAddress(), amount);
  await controller.connect(funder).allocateRevenue();
}

describe("ArcOrigin AORG buyback controller", function () {
  it("immutably allocates protocol revenue 80/20 and lets anyone settle new revenue", async function () {
    const platform = await deployProtocolToken();
    const { funder, operations, usdc, controller } = platform;
    const controllerAddress = await controller.getAddress();
    const revenue = 100n * USDC;
    const operationsBefore = await usdc.balanceOf(operations.address);

    await usdc.connect(funder).transfer(controllerAddress, revenue);
    await expect(controller.connect(funder).allocateRevenue())
      .to.emit(controller, "RevenueAllocated")
      .withArgs(revenue, 80n * USDC, 20n * USDC);

    expect(await controller.pendingBuybackUsdc()).to.equal(80n * USDC);
    expect(await controller.totalRevenueAllocated()).to.equal(revenue);
    expect(await controller.totalOperationsTransferred()).to.equal(20n * USDC);
    expect(await usdc.balanceOf(operations.address) - operationsBefore).to.equal(20n * USDC);
    expect(await usdc.balanceOf(controllerAddress)).to.equal(80n * USDC);
    await expect(controller.allocateRevenue()).to.be.revertedWithCustomError(controller, "NoRevenue");
  });

  it("executes a bounded TWAP slice and sends every purchased token to the burn address", async function () {
    const platform = await deployProtocolToken();
    const { executor, usdc, token, curve, controller } = platform;
    await fundAndAllocate(platform);

    const [quotedTokens] = await curve.quoteBuy(MAX_CHUNK);
    const minimumOutput = quotedTokens * (10_000n - MAX_SLIPPAGE_BPS) / 10_000n;
    const burnBalanceBefore = await token.balanceOf(BURN_ADDRESS);

    await expect(
      controller.connect(executor).executeBuyback(
        MAX_CHUNK,
        minimumOutput,
        await futureDeadline(),
      ),
    ).to.emit(controller, "BuybackExecuted");

    expect(await token.balanceOf(await controller.getAddress())).to.equal(0n);
    expect(await token.balanceOf(BURN_ADDRESS) - burnBalanceBefore).to.equal(quotedTokens);
    expect(await controller.totalTokensBurned()).to.equal(quotedTokens);
    expect(await controller.totalBuybackUsdcSpent()).to.equal(MAX_CHUNK);
    expect(await controller.pendingBuybackUsdc()).to.equal(55n * USDC);
    expect(await usdc.allowance(await controller.getAddress(), await curve.getAddress())).to.equal(0n);
  });

  it("enforces executor authorization, chunk size, cooldown, deadline, and onchain slippage bounds", async function () {
    const platform = await deployProtocolToken();
    const { executor, stranger, curve, controller } = platform;
    await fundAndAllocate(platform);
    const [quotedTokens] = await curve.quoteBuy(MAX_CHUNK);
    const minimumOutput = quotedTokens * (10_000n - MAX_SLIPPAGE_BPS) / 10_000n;

    await expect(
      controller.connect(stranger).executeBuyback(
        MAX_CHUNK,
        minimumOutput,
        await futureDeadline(),
      ),
    ).to.be.revertedWithCustomError(controller, "Unauthorized");
    await expect(
      controller.connect(executor).executeBuyback(
        MAX_CHUNK + 1n,
        minimumOutput,
        await futureDeadline(),
      ),
    ).to.be.revertedWithCustomError(controller, "ChunkLimitExceeded");
    await expect(
      controller.connect(executor).executeBuyback(
        MAX_CHUNK,
        minimumOutput - 1n,
        await futureDeadline(),
      ),
    ).to.be.revertedWithCustomError(controller, "InvalidMinimumOutput");
    await expect(
      controller.connect(executor).executeBuyback(
        MAX_CHUNK,
        minimumOutput,
        (await futureDeadline(1_000n)),
      ),
    ).to.be.revertedWithCustomError(controller, "InvalidDeadline");

    await controller.connect(executor).executeBuyback(
      MAX_CHUNK,
      minimumOutput,
      await futureDeadline(),
    );
    const [nextQuote] = await curve.quoteBuy(MAX_CHUNK);
    const nextMinimum = nextQuote * (10_000n - MAX_SLIPPAGE_BPS) / 10_000n;
    await expect(
      controller.connect(executor).executeBuyback(
        MAX_CHUNK,
        nextMinimum,
        await futureDeadline(),
      ),
    ).to.be.revertedWithCustomError(controller, "CooldownActive");

    await time.increase(EXECUTION_INTERVAL);
    await expect(
      controller.connect(executor).executeBuyback(
        MAX_CHUNK,
        nextMinimum,
        await futureDeadline(),
      ),
    ).to.emit(controller, "BuybackExecuted");
  });

  it("gives the guardian pause-only authority and keeps core assets unrecoverable", async function () {
    const platform = await deployProtocolToken();
    const {
      owner,
      funder,
      guardian,
      stranger,
      alternate,
      usdc,
      token,
      controller,
    } = platform;
    await fundAndAllocate(platform);

    await expect(controller.connect(stranger).pause())
      .to.be.revertedWithCustomError(controller, "Unauthorized");
    await controller.connect(guardian).pause();
    await expect(controller.connect(funder).allocateRevenue())
      .to.be.revertedWithCustomError(controller, "EnforcedPause");
    await expect(controller.connect(guardian).unpause())
      .to.be.revertedWithCustomError(controller, "OwnableUnauthorizedAccount")
      .withArgs(guardian.address);
    await controller.connect(owner).unpause();

    await expect(
      controller.connect(owner).recoverNonCoreToken(
        await usdc.getAddress(),
        alternate.address,
        USDC,
      ),
    ).to.be.revertedWithCustomError(controller, "CoreAssetRecoveryDisabled");
    await expect(
      controller.connect(owner).recoverNonCoreToken(
        await token.getAddress(),
        alternate.address,
        1n,
      ),
    ).to.be.revertedWithCustomError(controller, "CoreAssetRecoveryDisabled");
    await expect(controller.connect(owner).renounceOwnership())
      .to.be.revertedWithCustomError(controller, "RenounceDisabled");
  });

  it("requires two-step governance changes and prevents unsafe execution parameters", async function () {
    const platform = await deployProtocolToken();
    const { owner, stranger, alternate, controller } = platform;

    await expect(
      controller.connect(owner).setExecutionConfig(
        MAX_CHUNK + 1n,
        EXECUTION_INTERVAL,
        Number(MAX_SLIPPAGE_BPS),
      ),
    ).to.be.revertedWithCustomError(controller, "InvalidConfiguration");
    await expect(
      controller.connect(owner).setExecutionConfig(
        MAX_CHUNK,
        299,
        Number(MAX_SLIPPAGE_BPS),
      ),
    ).to.be.revertedWithCustomError(controller, "InvalidConfiguration");
    await expect(
      controller.connect(owner).setExecutionConfig(
        MAX_CHUNK,
        EXECUTION_INTERVAL,
        501,
      ),
    ).to.be.revertedWithCustomError(controller, "InvalidConfiguration");

    await controller.connect(owner).setExecutor(stranger.address, true);
    expect(await controller.isExecutor(stranger.address)).to.equal(true);
    await controller.connect(owner).setOperationsRecipient(alternate.address);
    expect(await controller.operationsRecipient()).to.equal(alternate.address);

    await controller.connect(owner).transferOwnership(stranger.address);
    expect(await controller.owner()).to.equal(owner.address);
    expect(await controller.pendingOwner()).to.equal(stranger.address);
    await controller.connect(stranger).acceptOwnership();
    expect(await controller.owner()).to.equal(stranger.address);
  });

  it("burns unsolicited AORG instead of allowing governance to recover it", async function () {
    const platform = await deployProtocolToken();
    const { creator, funder, usdc, token, curve, controller } = platform;
    const amount = 5n * USDC;
    const [quotedTokens] = await curve.quoteBuy(amount);
    await usdc.connect(funder).approve(await curve.getAddress(), amount);
    await curve.connect(funder).buy(amount, quotedTokens, await futureDeadline());
    const donation = quotedTokens / 2n;
    await token.connect(funder).transfer(await controller.getAddress(), donation);

    const burnBefore = await token.balanceOf(BURN_ADDRESS);
    await expect(controller.connect(creator).burnHeldProtocolTokens())
      .to.emit(controller, "ProtocolTokensBurned")
      .withArgs(creator.address, donation);
    expect(await token.balanceOf(BURN_ADDRESS) - burnBefore).to.equal(donation);
    expect(await controller.totalTokensBurned()).to.equal(donation);
  });

  it("rejects a mismatched or migration-enabled curve at deployment", async function () {
    const platform = await deployProtocolToken();
    const {
      owner,
      operations,
      executor,
      guardian,
      usdc,
      token,
      curve,
    } = platform;
    const Controller = await ethers.getContractFactory("ArcOriginBuybackController");

    await expect(
      Controller.deploy(
        owner.address,
        guardian.address,
        operations.address,
        executor.address,
        await usdc.getAddress(),
        await usdc.getAddress(),
        await curve.getAddress(),
        MAX_CHUNK,
        EXECUTION_INTERVAL,
        MAX_SLIPPAGE_BPS,
      ),
    ).to.be.revertedWithCustomError(Controller, "InvalidConfiguration");

    await expect(
      Controller.deploy(
        owner.address,
        guardian.address,
        operations.address,
        executor.address,
        await usdc.getAddress(),
        await token.getAddress(),
        await curve.getAddress(),
        MAX_CHUNK + 1n,
        EXECUTION_INTERVAL,
        MAX_SLIPPAGE_BPS,
      ),
    ).to.be.revertedWithCustomError(Controller, "InvalidConfiguration");
  });
});
