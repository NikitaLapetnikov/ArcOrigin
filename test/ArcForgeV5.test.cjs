const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = 10n ** 6n;
const TOKEN = 10n ** 18n;
const V5_LAUNCH_FEE = 10n * USDC;
const SUPPLY = 1_000_000_000n * TOKEN;

async function deployV5({ virtualReserve = 2_500n * USDC, graduationThreshold = 10_000n * USDC } = {}) {
  const [owner, creator, trader, recipient, stranger, locker] = await ethers.getSigners();
  const Usdc = await ethers.getContractFactory("MockUSDC");
  const usdc = await Usdc.deploy();
  const Vault = await ethers.getContractFactory("ArcForgeFeeVault");
  const vault = await Vault.deploy(owner.address, recipient.address);
  const Registry = await ethers.getContractFactory("ArcForgeCreatorRegistry");
  const registry = await Registry.deploy(owner.address);
  const Factory = await ethers.getContractFactory("ArcForgeFactoryV5");
  const factory = await Factory.deploy(
    owner.address,
    await usdc.getAddress(),
    await vault.getAddress(),
    await registry.getAddress(),
    V5_LAUNCH_FEE,
    virtualReserve,
    graduationThreshold,
  );
  await registry.setFactory(await factory.getAddress());
  await usdc.mint(creator.address, 1_000_000n * USDC);
  await usdc.mint(trader.address, 1_000_000n * USDC);
  return { owner, creator, trader, recipient, stranger, locker, usdc, vault, registry, factory };
}

async function launchV5(platform) {
  const { creator, usdc, factory } = platform;
  await usdc.connect(creator).approve(await factory.getAddress(), V5_LAUNCH_FEE);
  const tx = await factory.connect(creator).launchToken({
    name: "ArcOrigin V5",
    symbol: "ARCV5",
    metadataURI: "ipfs://v5",
  });
  const receipt = await tx.wait();
  const event = receipt.logs
    .map((log) => { try { return factory.interface.parseLog(log); } catch { return null; } })
    .find((entry) => entry?.name === "TokenLaunched");
  return {
    token: await ethers.getContractAt("ArcForgeToken", event.args.token),
    curve: await ethers.getContractAt("ArcForgeBondingCurveV5", event.args.curve),
  };
}

describe("ArcOrigin V5", function () {
  it("uses a 10 USDC launch fee and a canonical zero-allocation one-billion supply", async function () {
    const platform = await deployV5();
    const { creator, usdc, vault, factory } = platform;
    const { token, curve } = await launchV5(platform);

    expect(await factory.launchFee()).to.equal(V5_LAUNCH_FEE);
    expect(await token.totalSupply()).to.equal(SUPPLY);
    expect(await token.balanceOf(creator.address)).to.equal(0);
    expect(await token.balanceOf(await curve.getAddress())).to.equal(SUPPLY);
    expect(await vault.getFeeTotal(
      await usdc.getAddress(),
      ethers.keccak256(ethers.toUtf8Bytes("LAUNCH_FEE")),
    )).to.equal(V5_LAUNCH_FEE);
  });

  it("limits protected buyers and removes the restriction after the configured block window", async function () {
    const platform = await deployV5();
    const { owner, trader, usdc, factory } = platform;
    await factory.connect(owner).setLaunchProtection(20, 500, 550);
    const { curve } = await launchV5(platform);
    const curveAddress = await curve.getAddress();
    await usdc.connect(trader).approve(curveAddress, ethers.MaxUint256);

    const firstBuy = 100n * USDC;
    const [firstQuote] = await curve.quoteBuy(firstBuy);
    await curve.connect(trader).buy(firstBuy, firstQuote);
    const [secondQuote] = await curve.quoteBuy(firstBuy);
    await expect(curve.connect(trader).buy(firstBuy, secondQuote))
      .to.be.revertedWithCustomError(curve, "LaunchProtectionExceeded");

    await ethers.provider.send("hardhat_mine", ["0x20"]);
    await expect(curve.connect(trader).buy(firstBuy, secondQuote)).to.emit(curve, "TokenBought");
  });

  it("snapshots economics and migration configuration for future curves only", async function () {
    const platform = await deployV5();
    const { owner, locker, factory } = platform;
    const { curve: oldCurve } = await launchV5(platform);
    const Adapter = await ethers.getContractFactory("MockDexMigrationAdapter");
    const adapter = await Adapter.deploy();

    await factory.connect(owner).setLaunchEconomics(1_250n * USDC, 5_000n * USDC);
    await factory.connect(owner).setMigrationConfiguration(await adapter.getAddress(), locker.address);
    const { curve: newCurve } = await launchV5(platform);

    expect(await oldCurve.graduationThreshold()).to.equal(10_000n * USDC);
    expect(await oldCurve.dexMigrationAdapter()).to.equal(ethers.ZeroAddress);
    expect(await newCurve.graduationThreshold()).to.equal(5_000n * USDC);
    expect(await newCurve.dexMigrationAdapter()).to.equal(await adapter.getAddress());
    expect(await newCurve.liquidityLocker()).to.equal(locker.address);
  });

  it("migrates all real reserves atomically and disables curve trading", async function () {
    const platform = await deployV5({ virtualReserve: 25n * USDC, graduationThreshold: 100n * USDC });
    const { owner, trader, locker, usdc, factory } = platform;
    const Adapter = await ethers.getContractFactory("MockDexMigrationAdapter");
    const adapter = await Adapter.deploy();
    await factory.connect(owner).setLaunchProtection(0, 500, 550);
    await factory.connect(owner).setMigrationConfiguration(await adapter.getAddress(), locker.address);
    const { token, curve } = await launchV5(platform);
    const maximum = await curve.maxBuyAmount();
    const [quote] = await curve.quoteBuy(maximum);
    await usdc.connect(trader).approve(await curve.getAddress(), maximum);

    await expect(curve.connect(trader).buy(maximum, quote)).to.emit(curve, "DexMigrationCompleted");
    expect(await curve.isGraduated()).to.equal(true);
    expect(await curve.isMigrated()).to.equal(true);
    expect(await curve.migratedPool()).to.equal(await adapter.getAddress());
    expect(await curve.usdcReserve()).to.equal(0);
    expect(await curve.tokenReserve()).to.equal(0);
    expect(await usdc.balanceOf(await adapter.getAddress())).to.equal(100n * USDC);
    expect(await token.balanceOf(await adapter.getAddress())).to.equal(SUPPLY - quote);
    await expect(curve.connect(trader).buy(USDC, 0)).to.be.revertedWithCustomError(curve, "TradingMigrated");
  });

  it("rejects invalid economics, unsafe protection limits, and non-contract adapters", async function () {
    const platform = await deployV5();
    const { owner, stranger, locker, factory } = platform;
    await expect(factory.connect(owner).setLaunchEconomics(1_250n * USDC, 10_000n * USDC))
      .to.be.revertedWithCustomError(factory, "InvalidConfiguration");
    await expect(factory.connect(owner).setLaunchProtection(101, 500, 550))
      .to.be.revertedWithCustomError(factory, "InvalidConfiguration");
    await expect(factory.connect(owner).setMigrationConfiguration(stranger.address, locker.address))
      .to.be.revertedWithCustomError(factory, "InvalidConfiguration");
    await expect(factory.connect(stranger).setLaunchFee(1n))
      .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);
  });
});
