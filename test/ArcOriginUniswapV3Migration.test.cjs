const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = 10n ** 6n;
const TOKEN = 10n ** 18n;
const LAUNCH_FEE = 10n * USDC;

async function futureDeadline(seconds = 3_600n) {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block.timestamp) + seconds;
}

async function deployFixture() {
  const [owner, creator, trader, protocolRecipient, stranger, guardian] =
    await ethers.getSigners();

  const Usdc = await ethers.getContractFactory("MockUSDC");
  const usdc = await Usdc.deploy();
  const Vault = await ethers.getContractFactory("ArcForgeFeeVaultV6");
  const vault = await Vault.deploy(owner.address, protocolRecipient.address);
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
    25n * USDC,
    100n * USDC,
  );
  const factoryAddress = await factory.getAddress();
  await curveDeployer.bindFactory(factoryAddress);
  await vault.setRegistrar(factoryAddress, true);
  await vault.setCollector(factoryAddress, true);
  await registry.setFactory(factoryAddress);
  await factory.setLaunchProtection(0, 500, 550);

  const V3Factory = await ethers.getContractFactory("MockUniswapV3Factory");
  const v3Factory = await V3Factory.deploy();
  const PositionManager = await ethers.getContractFactory(
    "MockUniswapV3PositionManager",
  );
  const positionManager = await PositionManager.deploy(await v3Factory.getAddress());
  const Adapter = await ethers.getContractFactory(
    "ArcOriginUniswapV3MigrationAdapter",
  );
  const adapter = await Adapter.deploy(
    factoryAddress,
    await v3Factory.getAddress(),
    await positionManager.getAddress(),
    await usdc.getAddress(),
  );
  const Locker = await ethers.getContractFactory(
    "ArcOriginUniswapV3LiquidityLocker",
  );
  const locker = await Locker.deploy(
    await adapter.getAddress(),
    await positionManager.getAddress(),
    await vault.getAddress(),
  );
  const Verifier = await ethers.getContractFactory(
    "ArcOriginUniswapV3MigrationVerifier",
  );
  const verifier = await Verifier.deploy(
    factoryAddress,
    await v3Factory.getAddress(),
    await positionManager.getAddress(),
    await usdc.getAddress(),
    await adapter.getAddress(),
    await locker.getAddress(),
  );
  await factory.setMigrationConfiguration(
    await adapter.getAddress(),
    await locker.getAddress(),
    await verifier.getAddress(),
  );

  for (const signer of [creator, trader, stranger]) {
    await usdc.mint(signer.address, 1_000_000n * USDC);
  }

  return {
    owner,
    creator,
    trader,
    protocolRecipient,
    stranger,
    usdc,
    vault,
    factory,
    v3Factory,
    positionManager,
    adapter,
    locker,
    verifier,
  };
}

async function launchToken(fixture) {
  const { creator, usdc, factory } = fixture;
  await usdc.connect(creator).approve(await factory.getAddress(), LAUNCH_FEE);
  const receipt = await (
    await factory.connect(creator).launchToken({
      name: "ArcOrigin Migration",
      symbol: "AOM",
      metadataURI: "ipfs://migration",
    })
  ).wait();
  const launch = receipt.logs
    .map((log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((entry) => entry?.name === "TokenLaunched");
  return {
    token: await ethers.getContractAt("ArcForgeToken", launch.args.token),
    curve: await ethers.getContractAt(
      "ArcForgeBondingCurveV6",
      launch.args.curve,
    ),
  };
}

async function graduate(fixture, curve) {
  const maximum = await curve.maxBuyAmount();
  const [minimumTokens] = await curve.quoteBuy(maximum);
  await fixture.usdc
    .connect(fixture.trader)
    .approve(await curve.getAddress(), ethers.MaxUint256);
  await curve
    .connect(fixture.trader)
    .buy(maximum, minimumTokens, await futureDeadline());
  expect(await curve.isGraduated()).to.equal(true);
}

describe("ArcOrigin permanent Uniswap V3 migration", function () {
  it("moves only accounted reserves into a fresh pool and permanently locks the LP NFT", async function () {
    const fixture = await deployFixture();
    const {
      owner,
      stranger,
      factory,
      v3Factory,
      positionManager,
      locker,
    } = fixture;
    const { token, curve } = await launchToken(fixture);
    await graduate(fixture, curve);
    const tokenReserve = await curve.tokenReserve();
    const quoteReserve = await curve.usdcReserve();
    await factory.connect(owner).unpauseMigrations();

    await expect(curve.connect(stranger).migrateToDex())
      .to.emit(curve, "DexMigrationCompleted");

    const pool = await curve.migratedPool();
    const positionId = await curve.migratedPositionId();
    const tokenAddress = await token.getAddress();
    const quoteAddress = await fixture.usdc.getAddress();
    expect(pool).to.equal(
      await v3Factory.getPool(tokenAddress, quoteAddress, 10_000),
    );
    expect(await positionManager.ownerOf(positionId)).to.equal(
      await locker.getAddress(),
    );
    expect(await curve.isMigrated()).to.equal(true);
    expect(await curve.tokenReserve()).to.equal(0n);
    expect(await curve.usdcReserve()).to.equal(0n);
    expect(await token.balanceOf(pool)).to.equal(tokenReserve);
    expect(await fixture.usdc.balanceOf(pool)).to.equal(quoteReserve);

    const record = await locker.getPositionRecord(positionId);
    expect(record.pool).to.equal(pool);
    expect(record.creatorFeeRecipient).to.equal(fixture.creator.address);
    expect(record.creatorFeeShareBps).to.equal(7_000n);
    expect(record.amount0Used).to.equal(record.principal0);
    expect(record.amount1Used).to.equal(record.principal1);

    await expect(
      positionManager
        .connect(stranger)
        .transferFrom(await locker.getAddress(), stranger.address, positionId),
    ).to.be.revertedWithCustomError(positionManager, "InvalidPosition");
  });

  it("permissionlessly collects swap fees while sending exactly 70% to creator and 30% to protocol", async function () {
    const fixture = await deployFixture();
    const {
      owner,
      creator,
      trader,
      stranger,
      vault,
      factory,
      positionManager,
      locker,
      usdc,
    } = fixture;
    const { token, curve } = await launchToken(fixture);
    await graduate(fixture, curve);
    await factory.connect(owner).unpauseMigrations();
    await curve.migrateToDex();
    const positionId = await curve.migratedPositionId();
    const record = await locker.getPositionRecord(positionId);

    const tokenFee = 1_000n * TOKEN;
    const quoteFee = 100n * USDC;
    const amount0 = record.token0 === (await token.getAddress()) ? tokenFee : quoteFee;
    const amount1 = record.token1 === (await token.getAddress()) ? tokenFee : quoteFee;
    const asset0 = await ethers.getContractAt("IERC20", record.token0);
    const asset1 = await ethers.getContractAt("IERC20", record.token1);
    const positionManagerAddress = await positionManager.getAddress();
    await asset0.connect(trader).approve(positionManagerAddress, amount0);
    await asset1.connect(trader).approve(positionManagerAddress, amount1);
    await positionManager.connect(trader).seedFees(positionId, amount0, amount1);

    const creator0Before = await asset0.balanceOf(creator.address);
    const creator1Before = await asset1.balanceOf(creator.address);
    const protocol0Before = await asset0.balanceOf(await vault.getAddress());
    const protocol1Before = await asset1.balanceOf(await vault.getAddress());

    await expect(locker.connect(stranger).collectFees(positionId))
      .to.emit(locker, "FeesClaimed");

    const creator0After = await asset0.balanceOf(creator.address);
    const creator1After = await asset1.balanceOf(creator.address);
    const protocol0After = await asset0.balanceOf(await vault.getAddress());
    const protocol1After = await asset1.balanceOf(await vault.getAddress());

    expect(creator0After - creator0Before).to.equal(amount0 * 7n / 10n);
    expect(creator1After - creator1Before).to.equal(amount1 * 7n / 10n);
    expect(protocol0After - protocol0Before).to.equal(amount0 * 3n / 10n);
    expect(protocol1After - protocol1Before).to.equal(amount1 * 3n / 10n);
  });

  it("rejects unauthorized sources and safely leaves the curve active if a pool was pre-created", async function () {
    const fixture = await deployFixture();
    const {
      owner,
      creator,
      trader,
      stranger,
      factory,
      v3Factory,
      adapter,
      locker,
      usdc,
    } = fixture;
    const { token, curve } = await launchToken(fixture);

    await expect(
      adapter.connect(stranger).migrate({
        token: await token.getAddress(),
        quoteToken: await usdc.getAddress(),
        tokenAmount: 1,
        quoteAmount: 1,
        liquidityLocker: await locker.getAddress(),
        creatorFeeRecipient: creator.address,
        creatorFeeShareBps: 7_000,
      }),
    ).to.be.revertedWithCustomError(adapter, "UnauthorizedCurve");

    const pool = await v3Factory
      .connect(stranger)
      .createPool(await token.getAddress(), await usdc.getAddress(), 10_000);
    const poolAddress = await v3Factory.getPool(
      await token.getAddress(),
      await usdc.getAddress(),
      10_000,
    );
    expect(poolAddress).not.to.equal(ethers.ZeroAddress);
    await graduate(fixture, curve);
    const tokenReserve = await curve.tokenReserve();
    const quoteReserve = await curve.usdcReserve();
    await factory.connect(owner).unpauseMigrations();

    await expect(curve.migrateToDex()).to.be.revertedWithCustomError(
      adapter,
      "ExistingPool",
    );
    expect(await curve.isMigrated()).to.equal(false);
    expect(await curve.tokenReserve()).to.equal(tokenReserve);
    expect(await curve.usdcReserve()).to.equal(quoteReserve);

    const [tokensOut] = await curve.quoteBuy(USDC);
    await expect(
      curve.connect(trader).buy(USDC, tokensOut, await futureDeadline()),
    ).to.emit(curve, "TokenBought");
    expect(pool).not.to.equal(undefined);
  });

  it("rejects a locker that diverts the protocol share away from the canonical FeeVault", async function () {
    const fixture = await deployFixture();
    const {
      owner,
      stranger,
      factory,
      v3Factory,
      positionManager,
      adapter,
      usdc,
    } = fixture;
    const Locker = await ethers.getContractFactory(
      "ArcOriginUniswapV3LiquidityLocker",
    );
    const wrongLocker = await Locker.deploy(
      await adapter.getAddress(),
      await positionManager.getAddress(),
      stranger.address,
    );
    const Verifier = await ethers.getContractFactory(
      "ArcOriginUniswapV3MigrationVerifier",
    );
    const wrongVerifier = await Verifier.deploy(
      await factory.getAddress(),
      await v3Factory.getAddress(),
      await positionManager.getAddress(),
      await usdc.getAddress(),
      await adapter.getAddress(),
      await wrongLocker.getAddress(),
    );
    await factory.connect(owner).setMigrationConfiguration(
      await adapter.getAddress(),
      await wrongLocker.getAddress(),
      await wrongVerifier.getAddress(),
    );

    const { curve } = await launchToken(fixture);
    await graduate(fixture, curve);
    await factory.connect(owner).unpauseMigrations();

    await expect(curve.migrateToDex()).to.be.revertedWithCustomError(
      adapter,
      "InvalidConfiguration",
    );
    expect(await curve.isMigrated()).to.equal(false);
    expect(await curve.tokenReserve()).to.be.greaterThan(0n);
    expect(await curve.usdcReserve()).to.be.greaterThan(0n);
  });
});
