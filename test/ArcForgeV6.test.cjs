const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = 10n ** 6n;
const TOKEN = 10n ** 18n;
const LAUNCH_FEE = 10n * USDC;
const SUPPLY = 1_000_000_000n * TOKEN;

async function deployV6({
  usdcContract = "MockUSDC",
  virtualReserve = 2_500n * USDC,
  graduationThreshold = 10_000n * USDC,
} = {}) {
  const [owner, creator, trader, recipient, stranger, guardian, alternate] =
    await ethers.getSigners();
  const Usdc = await ethers.getContractFactory(usdcContract);
  const usdc = await Usdc.deploy();
  const Vault = await ethers.getContractFactory("ArcForgeFeeVaultV6");
  const vault = await Vault.deploy(owner.address, recipient.address);
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
    virtualReserve,
    graduationThreshold,
  );
  const factoryAddress = await factory.getAddress();
  await curveDeployer.bindFactory(factoryAddress);
  await vault.setRegistrar(factoryAddress, true);
  await vault.setCollector(factoryAddress, true);
  await registry.setFactory(factoryAddress);

  for (const signer of [creator, trader, stranger]) {
    await usdc.mint(signer.address, 1_000_000n * USDC);
  }
  return {
    owner,
    creator,
    trader,
    recipient,
    stranger,
    guardian,
    alternate,
    usdc,
    vault,
    registry,
    curveDeployer,
    factory,
  };
}

async function launchV6(platform, overrides = {}) {
  const { creator, usdc, factory } = platform;
  await usdc.connect(creator).approve(await factory.getAddress(), LAUNCH_FEE);
  const tx = await factory.connect(creator).launchToken({
    name: "ArcOrigin V6",
    symbol: "ARCV6",
    metadataURI: "ipfs://v6",
    ...overrides,
  });
  const receipt = await tx.wait();
  const event = receipt.logs
    .map((log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((entry) => entry?.name === "TokenLaunched");
  return {
    token: await ethers.getContractAt("ArcForgeToken", event.args.token),
    curve: await ethers.getContractAt("ArcForgeBondingCurveV6", event.args.curve),
    tx,
  };
}

async function futureDeadline(seconds = 3_600n) {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block.timestamp) + seconds;
}

async function deployMigrationMocks(adapterContract = "MockDexMigrationAdapterV6") {
  const Locker = await ethers.getContractFactory("MockLiquidityLockerV6");
  const locker = await Locker.deploy();
  const Adapter = await ethers.getContractFactory(adapterContract);
  const adapter = await Adapter.deploy();
  const Verifier = await ethers.getContractFactory("MockMigrationVerifierV6");
  const verifier = await Verifier.deploy();
  return { locker, adapter, verifier };
}

async function graduate(platform, curve) {
  const { trader, usdc } = platform;
  const maximum = await curve.maxBuyAmount();
  const [quote] = await curve.quoteBuy(maximum);
  await usdc.connect(trader).approve(await curve.getAddress(), ethers.MaxUint256);
  await curve.connect(trader).buy(maximum, quote, await futureDeadline());
  return { maximum, quote };
}

describe("ArcOrigin V6 secure launch architecture", function () {
  it("deploys a canonical launch, authorizes only its curve, and exposes bounded pagination", async function () {
    const platform = await deployV6();
    const { creator, usdc, vault, registry, curveDeployer, factory } = platform;
    const { token, curve } = await launchV6(platform);

    expect(await curveDeployer.factory()).to.equal(await factory.getAddress());
    expect(await curveDeployer.owner()).to.equal(ethers.ZeroAddress);
    expect(await token.totalSupply()).to.equal(SUPPLY);
    expect(await token.balanceOf(creator.address)).to.equal(0);
    expect(await token.balanceOf(await curve.getAddress())).to.equal(SUPPLY);
    expect(await vault.isCollector(await factory.getAddress())).to.equal(true);
    expect(await vault.isCollector(await curve.getAddress())).to.equal(true);
    expect((await registry.getCreatorProfile(creator.address)).launchCount).to.equal(1n);
    expect(await factory.getLaunchedTokenCount()).to.equal(1n);
    expect(await factory.getCreatorTokenCount(creator.address)).to.equal(1n);
    expect(await factory.getLaunchedTokens(0, 10)).to.deep.equal([await token.getAddress()]);
    await expect(factory.getLaunchedTokens(0, 101))
      .to.be.revertedWithCustomError(factory, "InvalidPage");
    expect(
      await vault.getFeeTotal(
        await usdc.getAddress(),
        ethers.keccak256(ethers.toUtf8Bytes("LAUNCH_FEE")),
      ),
    ).to.equal(LAUNCH_FEE);
  });

  it("rejects fake fee records and prevents the recipient from bypassing governance withdrawals", async function () {
    const platform = await deployV6();
    const { owner, creator, recipient, stranger, usdc, vault } = platform;
    const vaultAddress = await vault.getAddress();
    const feeType = ethers.keccak256(ethers.toUtf8Bytes("FAKE_FEE"));
    await usdc.connect(stranger).approve(vaultAddress, USDC);

    await expect(
      vault.connect(stranger).collectFee(
        await usdc.getAddress(),
        stranger.address,
        feeType,
        USDC,
      ),
    ).to.be.revertedWithCustomError(vault, "UnauthorizedCollector");
    await expect(vault.connect(recipient).withdraw(await usdc.getAddress(), USDC))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
      .withArgs(recipient.address);
    await expect(vault.connect(owner).renounceOwnership())
      .to.be.revertedWithCustomError(vault, "RenounceDisabled");

    await launchV6(platform);
    const balanceBefore = await usdc.balanceOf(recipient.address);
    await vault.connect(owner).withdraw(await usdc.getAddress(), LAUNCH_FEE);
    expect(await usdc.balanceOf(recipient.address) - balanceBefore).to.equal(LAUNCH_FEE);
    expect(await usdc.balanceOf(creator.address)).to.equal(1_000_000n * USDC - LAUNCH_FEE);
  });

  it("requires the nominated governance account to accept every ownership transfer", async function () {
    const platform = await deployV6();
    const { owner, stranger, vault, registry, factory } = platform;

    for (const contract of [vault, registry, factory]) {
      await contract.connect(owner).transferOwnership(stranger.address);
      expect(await contract.owner()).to.equal(owner.address);
      expect(await contract.pendingOwner()).to.equal(stranger.address);
      await expect(contract.connect(owner).acceptOwnership())
        .to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount")
        .withArgs(owner.address);
      await contract.connect(stranger).acceptOwnership();
      expect(await contract.owner()).to.equal(stranger.address);
      expect(await contract.pendingOwner()).to.equal(ethers.ZeroAddress);
    }

    await expect(factory.connect(owner).setLaunchFee(USDC))
      .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
      .withArgs(owner.address);
    await factory.connect(stranger).setLaunchFee(USDC);
    expect(await factory.launchFee()).to.equal(USDC);
  });

  it("accrues creator fees without external transfers and lets only the creator choose the claim recipient", async function () {
    const platform = await deployV6();
    const { creator, trader, stranger, alternate, usdc, vault } = platform;
    const { curve } = await launchV6(platform);
    const curveAddress = await curve.getAddress();
    const amount = 100n * USDC;
    const [quote, fee] = await curve.quoteBuy(amount);
    await usdc.connect(trader).approve(curveAddress, amount);
    const creatorBalanceBefore = await usdc.balanceOf(creator.address);
    await curve.connect(trader).buy(amount, quote, await futureDeadline());

    const protocolFee = fee * 3_000n / 10_000n;
    const creatorFee = fee - protocolFee;
    expect(await usdc.balanceOf(creator.address)).to.equal(creatorBalanceBefore);
    expect(await curve.claimableCreatorFees()).to.equal(creatorFee);
    expect(
      await vault.getFeeTotal(
        await usdc.getAddress(),
        ethers.keccak256(ethers.toUtf8Bytes("BUY_FEE")),
      ),
    ).to.equal(protocolFee);
    await expect(curve.connect(stranger).claimCreatorFees(stranger.address))
      .to.be.revertedWithCustomError(curve, "Unauthorized");

    const alternateBefore = await usdc.balanceOf(alternate.address);
    await expect(curve.connect(creator).claimCreatorFees(alternate.address))
      .to.emit(curve, "CreatorFeesClaimed")
      .withArgs(creator.address, alternate.address, creatorFee);
    expect(await usdc.balanceOf(alternate.address) - alternateBefore).to.equal(creatorFee);
    expect(await curve.claimableCreatorFees()).to.equal(0n);
  });

  it("keeps trading operational when the quote token blocks the creator address", async function () {
    const platform = await deployV6({ usdcContract: "MockRestrictedUSDC" });
    const { creator, trader, alternate, usdc } = platform;
    const { curve } = await launchV6(platform);
    await usdc.setBlocked(creator.address, true);
    const amount = 100n * USDC;
    const [quote] = await curve.quoteBuy(amount);
    await usdc.connect(trader).approve(await curve.getAddress(), amount);

    await expect(curve.connect(trader).buy(amount, quote, await futureDeadline()))
      .to.emit(curve, "TokenBought");
    await expect(curve.connect(creator).claimCreatorFees(creator.address)).to.be.revertedWith(
      "blocked recipient",
    );
    await expect(curve.connect(creator).claimCreatorFees(alternate.address))
      .to.emit(curve, "CreatorFeesClaimed");
  });

  it("enforces transaction deadlines, slippage, and bounded governance parameters", async function () {
    const platform = await deployV6();
    const { owner, trader, usdc, factory } = platform;
    const { curve } = await launchV6(platform);
    const amount = 100n * USDC;
    const [quote] = await curve.quoteBuy(amount);
    await usdc.connect(trader).approve(await curve.getAddress(), amount);
    const block = await ethers.provider.getBlock("latest");

    await expect(curve.connect(trader).buy(amount, quote, BigInt(block.timestamp) - 1n))
      .to.be.revertedWithCustomError(curve, "Expired");
    await expect(curve.connect(trader).buy(amount, quote + 1n, await futureDeadline()))
      .to.be.revertedWithCustomError(curve, "SlippageExceeded");
    await expect(factory.connect(owner).setTradingFees(201, 100))
      .to.be.revertedWithCustomError(factory, "InvalidConfiguration");
    await expect(factory.connect(owner).setLaunchFee(101n * USDC))
      .to.be.revertedWithCustomError(factory, "InvalidConfiguration");
    await expect(factory.connect(owner).renounceOwnership())
      .to.be.revertedWithCustomError(factory, "RenounceDisabled");
  });

  it("rejects fee-on-transfer quote assets before accounting can become insolvent", async function () {
    const platform = await deployV6({ usdcContract: "MockFeeOnTransferUSDC" });
    await expect(launchV6(platform))
      .to.be.revertedWithCustomError(platform.factory, "UnsupportedTokenBehavior");
    expect(await platform.factory.getLaunchedTokenCount()).to.equal(0n);
  });

  it("graduates safely while migration is paused and continues internal AMM trading", async function () {
    const platform = await deployV6({
      virtualReserve: 25n * USDC,
      graduationThreshold: 100n * USDC,
    });
    const { owner, trader, usdc, factory } = platform;
    const { locker, adapter, verifier } = await deployMigrationMocks();
    await factory.connect(owner).setLaunchProtection(0, 500, 550);
    await factory.connect(owner).setMigrationConfiguration(
      await adapter.getAddress(),
      await locker.getAddress(),
      await verifier.getAddress(),
    );
    const { curve } = await launchV6(platform);
    const maximum = await curve.maxBuyAmount();
    const [quote] = await curve.quoteBuy(maximum);
    await usdc.connect(trader).approve(await curve.getAddress(), ethers.MaxUint256);

    await expect(curve.connect(trader).buy(maximum, quote, await futureDeadline()))
      .to.emit(curve, "CurveGraduated")
      .and.to.emit(curve, "PermanentLiquidityActivated");
    expect(await curve.isGraduated()).to.equal(true);
    expect(await curve.isMigrated()).to.equal(false);
    await expect(curve.migrateToDex()).to.be.revertedWithCustomError(curve, "MigrationUnavailable");

    const postGraduationAmount = USDC;
    const [postGraduationQuote] = await curve.quoteBuy(postGraduationAmount);
    await expect(
      curve.connect(trader).buy(
        postGraduationAmount,
        postGraduationQuote,
        await futureDeadline(),
      ),
    ).to.emit(curve, "TokenBought");
  });

  it("ignores unsolicited donation dust and migrates only accounted reserves", async function () {
    const platform = await deployV6({
      virtualReserve: 25n * USDC,
      graduationThreshold: 100n * USDC,
    });
    const { owner, stranger, usdc, factory } = platform;
    const { locker, adapter, verifier } = await deployMigrationMocks();
    await factory.connect(owner).setLaunchProtection(0, 500, 550);
    await factory.connect(owner).setMigrationConfiguration(
      await adapter.getAddress(),
      await locker.getAddress(),
      await verifier.getAddress(),
    );
    const { token, curve } = await launchV6(platform);
    await graduate(platform, curve);
    const tokenLiquidity = await curve.tokenReserve();
    const quoteLiquidity = await curve.usdcReserve();
    const pendingCreatorFees = await curve.claimableCreatorFees();
    await usdc.connect(stranger).transfer(await curve.getAddress(), 1n);
    await token.connect(platform.trader).transfer(await curve.getAddress(), 1n);
    await factory.connect(owner).unpauseMigrations();

    await expect(curve.connect(stranger).migrateToDex())
      .to.emit(curve, "DexMigrationCompleted");
    expect(await curve.isMigrated()).to.equal(true);
    expect(await curve.tokenReserve()).to.equal(0n);
    expect(await curve.usdcReserve()).to.equal(0n);
    expect(await token.balanceOf(await locker.getAddress())).to.equal(tokenLiquidity);
    expect(await usdc.balanceOf(await locker.getAddress())).to.equal(quoteLiquidity);
    expect(await token.balanceOf(await curve.getAddress())).to.equal(1n);
    expect(await usdc.balanceOf(await curve.getAddress())).to.equal(pendingCreatorFees + 1n);
  });

  it("rejects a stealing adapter atomically and leaves the permanent AMM usable", async function () {
    const platform = await deployV6({
      virtualReserve: 25n * USDC,
      graduationThreshold: 100n * USDC,
    });
    const { owner, trader, usdc, factory } = platform;
    const { locker, adapter, verifier } = await deployMigrationMocks(
      "MockMaliciousMigrationAdapterV6",
    );
    await factory.connect(owner).setLaunchProtection(0, 500, 550);
    await factory.connect(owner).setMigrationConfiguration(
      await adapter.getAddress(),
      await locker.getAddress(),
      await verifier.getAddress(),
    );
    const { token, curve } = await launchV6(platform);
    await graduate(platform, curve);
    const tokenReserve = await curve.tokenReserve();
    const usdcReserve = await curve.usdcReserve();
    await factory.connect(owner).unpauseMigrations();

    await expect(curve.migrateToDex()).to.be.revertedWithCustomError(curve, "MigrationFailed");
    expect(await curve.isMigrated()).to.equal(false);
    expect(await curve.tokenReserve()).to.equal(tokenReserve);
    expect(await curve.usdcReserve()).to.equal(usdcReserve);
    expect(await token.balanceOf(await adapter.getAddress())).to.equal(0n);
    expect(await usdc.balanceOf(await adapter.getAddress())).to.equal(0n);

    const [quote] = await curve.quoteBuy(USDC);
    await expect(curve.connect(trader).buy(USDC, quote, await futureDeadline()))
      .to.emit(curve, "TokenBought");
  });

  it("lets the guardian only stop launches and migrations while governance alone can resume them", async function () {
    const platform = await deployV6();
    const { owner, creator, guardian, stranger, factory } = platform;
    await expect(factory.connect(guardian).pauseLaunches()).to.emit(factory, "Paused");
    await expect(
      factory.connect(creator).launchToken({
        name: "Paused",
        symbol: "PAUSE",
        metadataURI: "",
      }),
    ).to.be.revertedWithCustomError(factory, "EnforcedPause");
    await expect(factory.connect(guardian).unpauseLaunches())
      .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
      .withArgs(guardian.address);
    await factory.connect(owner).unpauseLaunches();
    await expect(factory.connect(stranger).pauseLaunches())
      .to.be.revertedWithCustomError(factory, "Unauthorized");

    const { locker, adapter, verifier } = await deployMigrationMocks();
    await factory.connect(owner).setMigrationConfiguration(
      await adapter.getAddress(),
      await locker.getAddress(),
      await verifier.getAddress(),
    );
    await factory.connect(owner).unpauseMigrations();
    await factory.connect(guardian).pauseMigrations();
    expect(await factory.migrationPaused()).to.equal(true);
    await expect(factory.connect(guardian).unpauseMigrations())
      .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
      .withArgs(guardian.address);
  });

  it("revokes old migration tuples when governance installs a new configuration", async function () {
    const platform = await deployV6({
      virtualReserve: 25n * USDC,
      graduationThreshold: 100n * USDC,
    });
    const { owner, factory } = platform;
    const first = await deployMigrationMocks();
    await factory.connect(owner).setLaunchProtection(0, 500, 550);
    await factory.connect(owner).setMigrationConfiguration(
      await first.adapter.getAddress(),
      await first.locker.getAddress(),
      await first.verifier.getAddress(),
    );
    const { curve } = await launchV6(platform);
    await graduate(platform, curve);
    const oldHash = await curve.migrationConfigurationHash();

    const second = await deployMigrationMocks();
    await factory.connect(owner).setMigrationConfiguration(
      await second.adapter.getAddress(),
      await second.locker.getAddress(),
      await second.verifier.getAddress(),
    );
    await factory.connect(owner).unpauseMigrations();
    expect(await factory.isMigrationConfigurationApproved(oldHash)).to.equal(false);
    await expect(curve.migrateToDex()).to.be.revertedWithCustomError(
      curve,
      "MigrationUnavailable",
    );
  });

  it("preserves accounting and a non-decreasing invariant across randomized V6 trades", async function () {
    const platform = await deployV6({
      virtualReserve: 25n * USDC,
      graduationThreshold: 100n * USDC,
    });
    const { owner, trader, usdc, factory } = platform;
    await factory.connect(owner).setLaunchProtection(0, 500, 550);
    const { token, curve } = await launchV6(platform);
    await graduate(platform, curve);
    const curveAddress = await curve.getAddress();
    await token.connect(trader).approve(curveAddress, ethers.MaxUint256);

    let seed = 0xA6C0A11n;
    const nextRandom = () => {
      seed ^= seed << 13n;
      seed ^= seed >> 7n;
      seed ^= seed << 17n;
      return seed & ((1n << 64n) - 1n);
    };

    for (let iteration = 0; iteration < 48; iteration += 1) {
      const invariantBefore = (await curve.usdcReserve()) * (await curve.tokenReserve());
      const traderTokens = await token.balanceOf(trader.address);
      const shouldBuy = traderTokens === 0n || nextRandom() % 3n !== 0n;
      if (shouldBuy) {
        const amount = (nextRandom() % 10n + 1n) * USDC;
        const [quote] = await curve.quoteBuy(amount);
        await curve.connect(trader).buy(amount, quote, await futureDeadline());
      } else {
        const amount = traderTokens * (nextRandom() % 20n + 1n) / 100n;
        const [quote] = await curve.quoteSell(amount);
        if (quote > 0n) {
          await curve.connect(trader).sell(amount, quote, await futureDeadline());
        }
      }

      const invariantAfter = (await curve.usdcReserve()) * (await curve.tokenReserve());
      expect(invariantAfter).to.be.at.least(invariantBefore);
      expect(await token.balanceOf(curveAddress)).to.equal(await curve.tokenReserve());
      expect(await usdc.balanceOf(curveAddress)).to.equal(
        (await curve.usdcReserve()) + (await curve.claimableCreatorFees()),
      );
    }
  });
});
