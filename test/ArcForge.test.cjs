const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = 10n ** 6n;
const TOKEN = 10n ** 18n;
const TOTAL_SUPPLY = 1_000_000_000n * TOKEN;
const LAUNCH_FEE = 1n * USDC;
const Q192 = 1n << 192n;

function sqrt(value) {
  if (value < 0n) throw new Error("negative square root");
  if (value < 2n) return value;
  let left = 1n;
  let right = value;
  while (left + 1n < right) {
    const middle = (left + right) >> 1n;
    if (middle * middle <= value) left = middle;
    else right = middle;
  }
  return left;
}

function sqrtPriceX96(tokenAddress, usdcAddress, marketCap) {
  const tokenIsToken0 = BigInt(tokenAddress) < BigInt(usdcAddress);
  const amount0 = tokenIsToken0 ? TOTAL_SUPPLY : marketCap;
  const amount1 = tokenIsToken0 ? marketCap : TOTAL_SUPPLY;
  return sqrt((amount1 * Q192) / amount0);
}

async function deployFixture() {
  const [owner, creator, trader, protocolRecipient, stranger, guardian] =
    await ethers.getSigners();
  const Usdc = await ethers.getContractFactory("MockUSDC");
  const usdc = await Usdc.deploy();
  const Vault = await ethers.getContractFactory("ArcForgeFeeVault");
  const vault = await Vault.deploy(owner.address, protocolRecipient.address);
  const Registry = await ethers.getContractFactory("ArcForgeCreatorRegistry");
  const registry = await Registry.deploy(owner.address);
  const V3Factory = await ethers.getContractFactory("MockUniswapV3Factory");
  const v3Factory = await V3Factory.deploy();
  const PositionManager = await ethers.getContractFactory(
    "MockUniswapV3PositionManager",
  );
  const positionManager = await PositionManager.deploy(await v3Factory.getAddress());
  const Router = await ethers.getContractFactory("MockUniswapV3SwapRouter");
  const router = await Router.deploy(await v3Factory.getAddress());
  const Factory = await ethers.getContractFactory("ArcForgeFactory");
  const factory = await Factory.deploy(
    owner.address,
    guardian.address,
    await usdc.getAddress(),
    await vault.getAddress(),
    await registry.getAddress(),
    await v3Factory.getAddress(),
    await positionManager.getAddress(),
    await router.getAddress(),
    LAUNCH_FEE,
  );
  const factoryAddress = await factory.getAddress();
  await vault.setRegistrar(factoryAddress, true);
  await vault.setCollector(factoryAddress, true);
  await registry.setFactory(factoryAddress);
  await factory.connect(owner).unpauseLaunches();
  await usdc.mint(creator.address, 1_000_000n * USDC);
  await usdc.mint(trader.address, 1_000_000n * USDC);
  return {
    owner,
    creator,
    trader,
    protocolRecipient,
    stranger,
    guardian,
    usdc,
    vault,
    registry,
    v3Factory,
    positionManager,
    router,
    factory,
    locker: await ethers.getContractAt(
      "ArcOriginUniswapV3LiquidityLocker",
      await factory.liquidityLocker(),
    ),
  };
}

async function launch(fixture, automaticBuyback = false) {
  await fixture.usdc
    .connect(fixture.creator)
    .approve(await fixture.factory.getAddress(), LAUNCH_FEE);
  const receipt = await (
    await fixture.factory.connect(fixture.creator).launchToken({
      name: "Arc Direct",
      symbol: "ARCD",
      metadataURI: "ipfs://arc-direct",
      automaticBuyback,
    })
  ).wait();
  const event = receipt.logs
    .map((log) => {
      try {
        return fixture.factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((entry) => entry?.name === "TokenLaunched");
  return {
    token: await ethers.getContractAt("ArcForgeToken", event.args.token),
    pool: await ethers.getContractAt("MockUniswapV3Pool", event.args.pool),
    positionId: event.args.positionId,
  };
}

async function predictNextToken(factory, creator, params) {
  const parent = await ethers.provider.getBlock("latest");
  const nonce = await factory.launchNonce();
  const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "address", "uint256"],
    [parent.hash, creator, nonce],
  ));
  const Token = await ethers.getContractFactory("ArcForgeToken");
  const deployment = await Token.getDeployTransaction(
    params.name,
    params.symbol,
    TOTAL_SUPPLY,
    creator,
    params.metadataURI,
  );
  return ethers.getCreate2Address(
    await factory.getAddress(),
    salt,
    ethers.keccak256(deployment.data),
  );
}

describe("ArcOrigin direct Uniswap V3 launches", function () {
  it("computes single-sided ranges and market cap for either token ordering", async function () {
    const Harness = await ethers.getContractFactory("MockArcOriginUniswapV3MathHarness");
    const harness = await Harness.deploy();
    expect(await harness.singleSidedTicks(-123, 200, true)).to.deep.equal([
      0n,
      887_200n,
    ]);
    expect(await harness.singleSidedTicks(-123, 200, false)).to.deep.equal([
      -887_200n,
      -200n,
    ]);

    const marketCap = 5_000n * USDC;
    const token0Price = sqrt((marketCap * Q192) / TOTAL_SUPPLY);
    const token1Price = sqrt((TOTAL_SUPPLY * Q192) / marketCap);
    const token0MarketCap = await harness.marketCapFromSqrtPriceX96(
      token0Price,
      TOTAL_SUPPLY,
      true,
    );
    const token1MarketCap = await harness.marketCapFromSqrtPriceX96(
      token1Price,
      TOTAL_SUPPLY,
      false,
    );
    expect(marketCap - token0MarketCap).to.be.lessThan(10n);
    expect(token1MarketCap - marketCap).to.be.lessThan(10n);
  });

  it("creates an indexable V3 pool and permanently locks the entire effective supply atomically", async function () {
    const fixture = await deployFixture();
    const { token, pool, positionId } = await launch(fixture);
    const tokenAddress = await token.getAddress();
    const poolAddress = await pool.getAddress();

    expect(
      await fixture.v3Factory.getPool(
        tokenAddress,
        await fixture.usdc.getAddress(),
        10_000,
      ),
    ).to.equal(poolAddress);
    expect(await fixture.positionManager.ownerOf(positionId)).to.equal(
      await fixture.locker.getAddress(),
    );
    expect(await token.balanceOf(poolAddress)).to.equal(await token.totalSupply());
    expect(await token.balanceOf(await fixture.factory.getAddress())).to.equal(0n);
    expect(await token.balanceOf(fixture.creator.address)).to.equal(0n);

    const record = await fixture.locker.locks(positionId);
    expect(record.pool).to.equal(poolAddress);
    expect(record.launchToken).to.equal(tokenAddress);
    expect(record.launchTokenPrincipal).to.equal(await token.totalSupply());
    expect(record.creatorFeeShareBps).to.equal(7_000n);
    const info = await fixture.factory.getTokenInfo(tokenAddress);
    expect(info.pool).to.equal(poolAddress);
    expect(info.positionId).to.equal(positionId);
  });

  it("does not expose a migration or LP-withdrawal path", async function () {
    const fixture = await deployFixture();
    const { positionId } = await launch(fixture);
    expect(fixture.factory.interface.hasFunction("migrateToDex")).to.equal(false);
    expect(fixture.locker.interface.hasFunction("transferFrom")).to.equal(false);
    expect(fixture.locker.interface.hasFunction("decreaseLiquidity")).to.equal(false);
    await expect(
      fixture.positionManager
        .connect(fixture.stranger)
        .transferFrom(
          await fixture.locker.getAddress(),
          fixture.stranger.address,
          positionId,
        ),
    ).to.be.revertedWithCustomError(fixture.positionManager, "InvalidPosition");
  });

  it("permissionlessly splits LP fees 70% to creator and 30% to the protocol vault", async function () {
    const fixture = await deployFixture();
    const { positionId } = await launch(fixture);
    const record = await fixture.locker.locks(positionId);
    const quoteIsToken0 = record.token0 === (await fixture.usdc.getAddress());
    const amount0 = quoteIsToken0 ? 100n * USDC : 0n;
    const amount1 = quoteIsToken0 ? 0n : 100n * USDC;
    await fixture.usdc
      .connect(fixture.trader)
      .approve(await fixture.positionManager.getAddress(), 100n * USDC);
    await fixture.positionManager
      .connect(fixture.trader)
      .seedFees(positionId, amount0, amount1);

    const creatorBefore = await fixture.usdc.balanceOf(fixture.creator.address);
    const protocolBefore = await fixture.usdc.balanceOf(await fixture.vault.getAddress());
    await expect(fixture.locker.connect(fixture.stranger).collectFees(positionId))
      .to.emit(fixture.locker, "FeesClaimed");
    expect(
      (await fixture.usdc.balanceOf(fixture.creator.address)) - creatorBefore,
    ).to.equal(70n * USDC);
    expect(
      (await fixture.usdc.balanceOf(await fixture.vault.getAddress())) - protocolBefore,
    ).to.equal(30n * USDC);
  });

  it("uses opt-in creator fees for permissionless buyback and true supply burn", async function () {
    const fixture = await deployFixture();
    const { token, pool, positionId } = await launch(fixture, true);
    const record = await fixture.locker.locks(positionId);
    const info = await fixture.factory.getTokenInfo(await token.getAddress());
    expect(record.automaticBuyback).to.equal(true);
    expect(info.automaticBuyback).to.equal(true);

    const tokenFees = 1_000n * TOKEN;
    await pool.pay(await token.getAddress(), fixture.trader.address, tokenFees);
    await token
      .connect(fixture.trader)
      .approve(await fixture.positionManager.getAddress(), tokenFees);
    await fixture.usdc
      .connect(fixture.trader)
      .approve(await fixture.positionManager.getAddress(), 10n * USDC);
    const quoteIsToken0 = record.token0 === (await fixture.usdc.getAddress());
    await fixture.positionManager.connect(fixture.trader).seedFees(
      positionId,
      quoteIsToken0 ? 10n * USDC : tokenFees,
      quoteIsToken0 ? tokenFees : 10n * USDC,
    );

    const creatorQuoteBefore = await fixture.usdc.balanceOf(fixture.creator.address);
    const supplyBeforeCollection = await token.totalSupply();
    await fixture.locker.connect(fixture.stranger).collectFees(positionId);
    expect(await fixture.locker.buybackReserve(positionId)).to.equal(7n * USDC);
    expect(await fixture.usdc.balanceOf(fixture.creator.address)).to.equal(
      creatorQuoteBefore,
    );
    expect(supplyBeforeCollection - (await token.totalSupply())).to.equal(
      700n * TOKEN,
    );

    const keeperBefore = await fixture.usdc.balanceOf(fixture.stranger.address);
    const supplyBeforeBuyback = await token.totalSupply();
    const expectedQuoteSpent = 6_965_000n;
    const expectedBurn = expectedQuoteSpent * 200_000n * 10n ** 12n;
    await expect(fixture.locker.connect(fixture.stranger).executeBuyback(positionId))
      .to.emit(fixture.locker, "BuybackExecuted")
      .withArgs(
        positionId,
        fixture.stranger.address,
        expectedQuoteSpent,
        34_825n,
        expectedBurn,
        175n,
      );
    expect(supplyBeforeBuyback - (await token.totalSupply())).to.equal(expectedBurn);
    expect(
      (await fixture.usdc.balanceOf(fixture.stranger.address)) - keeperBefore,
    ).to.equal(34_825n);
    expect(await fixture.locker.buybackReserve(positionId)).to.equal(175n);
  });

  it("rejects buybacks for ordinary launches and manipulated spot prices", async function () {
    const fixture = await deployFixture();
    const ordinary = await launch(fixture, false);
    await expect(
      fixture.locker.connect(fixture.stranger).executeBuyback(ordinary.positionId),
    ).to.be.revertedWithCustomError(fixture.locker, "BuybackDisabled");

    const automatic = await launch(fixture, true);
    const record = await fixture.locker.locks(automatic.positionId);
    const quoteIsToken0 = record.token0 === (await fixture.usdc.getAddress());
    await fixture.usdc
      .connect(fixture.trader)
      .approve(await fixture.positionManager.getAddress(), 10n * USDC);
    await fixture.positionManager.connect(fixture.trader).seedFees(
      automatic.positionId,
      quoteIsToken0 ? 10n * USDC : 0n,
      quoteIsToken0 ? 0n : 10n * USDC,
    );
    await fixture.locker.collectFees(automatic.positionId);
    await automatic.pool.setTicksForTest(601, 0);
    await expect(
      fixture.locker.connect(fixture.stranger).executeBuyback(automatic.positionId),
    ).to.be.revertedWithCustomError(fixture.locker, "UnsafePrice");
  });

  it("executes capped buybacks for both token address orderings", async function () {
    const fixture = await deployFixture();
    const launches = new Map();
    for (let index = 0; index < 32 && launches.size < 2; index += 1) {
      const launched = await launch(fixture, true);
      const record = await fixture.locker.locks(launched.positionId);
      const quoteIsToken0 = record.token0 === (await fixture.usdc.getAddress());
      if (!launches.has(quoteIsToken0)) launches.set(quoteIsToken0, launched);
    }
    expect(launches.size).to.equal(2);

    for (const [quoteIsToken0, launched] of launches) {
      await fixture.usdc
        .connect(fixture.trader)
        .approve(await fixture.positionManager.getAddress(), 300n * USDC);
      await fixture.positionManager.connect(fixture.trader).seedFees(
        launched.positionId,
        quoteIsToken0 ? 300n * USDC : 0n,
        quoteIsToken0 ? 0n : 300n * USDC,
      );
      const supplyBefore = await launched.token.totalSupply();
      const keeperBefore = await fixture.usdc.balanceOf(fixture.stranger.address);
      await fixture.locker
        .connect(fixture.stranger)
        .collectAndExecuteBuyback(launched.positionId);
      expect((await launched.token.totalSupply()) < supplyBefore).to.equal(true);
      expect(
        (await fixture.usdc.balanceOf(fixture.stranger.address)) - keeperBefore,
      ).to.equal(USDC);
      expect(await fixture.locker.buybackReserve(launched.positionId)).to.equal(0n);
    }
  });

  it("treats $50k as a permanent status mark without moving liquidity", async function () {
    const fixture = await deployFixture();
    const { token, pool, positionId } = await launch(fixture);
    const tokenAddress = await token.getAddress();
    expect(await fixture.factory.isCrossed(tokenAddress)).to.equal(false);
    const lockerOwnerBefore = await fixture.positionManager.ownerOf(positionId);

    const crossedPrice = sqrtPriceX96(
      tokenAddress,
      await fixture.usdc.getAddress(),
      50_100n * USDC,
    );
    await pool.setSqrtPriceX96ForTest(crossedPrice);
    expect(await fixture.factory.isCrossed(tokenAddress)).to.equal(true);
    await expect(fixture.factory.connect(fixture.stranger).markCrossed(tokenAddress))
      .to.emit(fixture.factory, "TokenCrossed");
    expect((await fixture.factory.getTokenInfo(tokenAddress)).crossed).to.equal(true);
    expect(await fixture.positionManager.ownerOf(positionId)).to.equal(lockerOwnerBefore);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(await token.totalSupply());
  });

  it("accepts a same-block uninitialized pool and cannot be permanently bricked by a poisoned prediction", async function () {
    const fixture = await deployFixture();
    const factoryAddress = await fixture.factory.getAddress();
    const params = {
      name: "Block Bound",
      symbol: "BBND",
      metadataURI: "ipfs://block-bound",
      automaticBuyback: false,
    };
    await fixture.usdc
      .connect(fixture.creator)
      .approve(factoryAddress, 3n * LAUNCH_FEE);

    const predictedToken = await predictNextToken(
      fixture.factory,
      fixture.creator.address,
      params,
    );
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      const poolTx = await fixture.v3Factory
        .connect(fixture.stranger)
        .createPool(
          predictedToken,
          await fixture.usdc.getAddress(),
          10_000,
          { gasLimit: 5_000_000 },
        );
      const launchTx = await fixture.factory
        .connect(fixture.creator)
        .launchToken(params, { gasLimit: 12_000_000 });
      await ethers.provider.send("evm_mine", []);
      expect((await ethers.provider.getTransactionReceipt(poolTx.hash)).status).to.equal(1);
      expect((await ethers.provider.getTransactionReceipt(launchTx.hash)).status).to.equal(1);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
    const expectedPool = await fixture.v3Factory.getPool(
      predictedToken,
      await fixture.usdc.getAddress(),
      10_000,
    );
    expect((await fixture.factory.getTokenInfo(predictedToken)).pool).to.equal(expectedPool);

    const poisonedParams = {
      name: "Poison Retry",
      symbol: "RETRY",
      metadataURI: "ipfs://retry",
      automaticBuyback: false,
    };
    const poisonedToken = await predictNextToken(
      fixture.factory,
      fixture.creator.address,
      poisonedParams,
    );
    let failedLaunchHash;
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
      const poisonTx = await fixture.positionManager
        .connect(fixture.stranger)
        .createAndInitializePoolIfNecessary(
          poisonedToken,
          await fixture.usdc.getAddress(),
          10_000,
          2n ** 96n,
          { gasLimit: 5_000_000 },
        );
      const failedLaunch = await fixture.factory
        .connect(fixture.creator)
        .launchToken(poisonedParams, { gasLimit: 12_000_000 });
      failedLaunchHash = failedLaunch.hash;
      await ethers.provider.send("evm_mine", []);
      expect((await ethers.provider.getTransactionReceipt(poisonTx.hash)).status).to.equal(1);
      expect((await ethers.provider.getTransactionReceipt(failedLaunch.hash)).status).to.equal(0);
    } finally {
      await ethers.provider.send("evm_setAutomine", [true]);
    }
    expect(failedLaunchHash).to.not.equal(undefined);

    const retryReceipt = await (
      await fixture.factory.connect(fixture.creator).launchToken(poisonedParams)
    ).wait();
    const retryEvent = retryReceipt.logs
      .map((log) => {
        try {
          return fixture.factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.name === "TokenLaunched");
    expect(retryEvent.args.token).to.not.equal(poisonedToken);
  });

  it("lets the guardian pause launches while only governance can unpause", async function () {
    const fixture = await deployFixture();
    await fixture.factory.connect(fixture.guardian).pauseLaunches();
    await expect(
      fixture.factory.connect(fixture.guardian).unpauseLaunches(),
    ).to.be.revertedWithCustomError(fixture.factory, "OwnableUnauthorizedAccount");
    await fixture.factory.connect(fixture.owner).unpauseLaunches();
    expect(await fixture.factory.paused()).to.equal(false);
  });
});
