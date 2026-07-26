const { expect } = require("chai");
const { ethers } = require("hardhat");

const USDC = 10n ** 6n;
const TOKEN = 10n ** 18n;
const LAUNCH_FEE = 25n * USDC;
const LIQUIDITY_LOCK = "0x000000000000000000000000000000000000dEaD";

async function deployPlatform() {
  const [owner, creator, trader, recipient, stranger] = await ethers.getSigners();
  const Usdc = await ethers.getContractFactory("MockUSDC");
  const usdc = await Usdc.deploy();
  const Vault = await ethers.getContractFactory("ArcForgeFeeVault");
  const vault = await Vault.deploy(owner.address, recipient.address);
  const Registry = await ethers.getContractFactory("ArcForgeCreatorRegistry");
  const registry = await Registry.deploy(owner.address);
  const Factory = await ethers.getContractFactory("ArcForgeFactory");
  const factory = await Factory.deploy(
    owner.address,
    await usdc.getAddress(),
    await vault.getAddress(),
    await registry.getAddress(),
    LAUNCH_FEE,
  );
  await registry.setFactory(await factory.getAddress());
  await usdc.mint(creator.address, 1_000_000n * USDC);
  await usdc.mint(trader.address, 1_000_000n * USDC);
  return { owner, creator, trader, recipient, stranger, usdc, vault, registry, factory };
}

function launchParams(overrides = {}) {
  return {
    name: "Forge Token",
    symbol: "FORGE",
    metadataURI: "ipfs://forge-metadata",
    totalSupply: 1_000_000_000n * TOKEN,
    creatorAllocationBps: 500,
    virtualUsdcReserve: 2_500n * USDC,
    graduationThreshold: 10_000n * USDC,
    ...overrides,
  };
}

async function launch(platform, overrides = {}) {
  const { creator, usdc, factory } = platform;
  await usdc.connect(creator).approve(await factory.getAddress(), LAUNCH_FEE);
  const tx = await factory.connect(creator).launchToken(launchParams(overrides));
  const receipt = await tx.wait();
  const parsed = receipt.logs
    .map((log) => { try { return factory.interface.parseLog(log); } catch { return null; } })
    .find((event) => event?.name === "TokenLaunched");
  return {
    token: await ethers.getContractAt("ArcForgeToken", parsed.args.token),
    curve: await ethers.getContractAt("ArcForgeBondingCurve", parsed.args.curve),
    tx,
  };
}

describe("ArcForgeFactory and ArcForgeToken", function () {
  it("launches a fixed-supply token, funds its curve, records the creator, and collects the launch fee", async function () {
    const platform = await deployPlatform();
    const { creator, factory, registry, vault, usdc } = platform;
    const params = launchParams();

    const { token, curve, tx } = await launch(platform);
    const creatorAllocation = params.totalSupply * 500n / 10_000n;
    const curveAllocation = params.totalSupply - creatorAllocation;

    await expect(tx).to.emit(factory, "TokenLaunched");
    expect(await token.totalSupply()).to.equal(params.totalSupply);
    expect(await token.balanceOf(creator.address)).to.equal(creatorAllocation);
    expect(await token.balanceOf(await curve.getAddress())).to.equal(curveAllocation);
    expect(await token.metadataURI()).to.equal("ipfs://forge-metadata");
    expect(token.interface.fragments.some((fragment) => fragment.name === "mint")).to.equal(false);
    expect((await registry.getCreatorProfile(creator.address)).launchCount).to.equal(1);
    expect(await vault.getFeeTotal(await usdc.getAddress(), ethers.keccak256(ethers.toUtf8Bytes("LAUNCH_FEE"))))
      .to.equal(LAUNCH_FEE);
  });

  it("rejects invalid names, symbols, and creator allocations", async function () {
    const platform = await deployPlatform();
    const { creator, usdc, factory } = platform;
    await usdc.connect(creator).approve(await factory.getAddress(), LAUNCH_FEE * 3n);
    await expect(factory.connect(creator).launchToken(launchParams({ name: "" }))).to.be.revertedWithCustomError(factory, "EmptyName");
    await expect(factory.connect(creator).launchToken(launchParams({ symbol: "" }))).to.be.revertedWithCustomError(factory, "EmptySymbol");
    await expect(factory.connect(creator).launchToken(launchParams({ name: "N".repeat(65) }))).to.be.revertedWithCustomError(factory, "NameTooLong");
    await expect(factory.connect(creator).launchToken(launchParams({ symbol: "SYMBOL-LONG" }))).to.be.revertedWithCustomError(factory, "SymbolTooLong");
    await expect(factory.connect(creator).launchToken(launchParams({ metadataURI: `ipfs://${"x".repeat(506)}` }))).to.be.revertedWithCustomError(factory, "MetadataURITooLong");
    await expect(factory.connect(creator).launchToken(launchParams({ creatorAllocationBps: 2001 })))
      .to.be.revertedWithCustomError(factory, "InvalidAllocation");
    await expect(factory.connect(creator).launchToken(launchParams({ graduationThreshold: 50_000n * USDC })))
      .to.be.revertedWithCustomError(factory, "InvalidConfiguration");
  });

  it("restricts fee administration and applies trading-fee changes only to future curves", async function () {
    const platform = await deployPlatform();
    const { owner, stranger, factory } = platform;
    const { curve: existingCurve } = await launch(platform);

    await expect(factory.connect(stranger).setLaunchFee(30n * USDC))
      .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);
    await expect(factory.connect(owner).setTradingFees(1_001, 100))
      .to.be.revertedWithCustomError(factory, "InvalidConfiguration");
    await expect(factory.connect(owner).setTradingFees(125, 150))
      .to.emit(factory, "TradingFeesUpdated")
      .withArgs(125, 150);

    const { curve: futureCurve } = await launch(platform);
    expect(await existingCurve.buyFeeBps()).to.equal(100n);
    expect(await existingCurve.sellFeeBps()).to.equal(100n);
    expect(await futureCurve.buyFeeBps()).to.equal(125n);
    expect(await futureCurve.sellFeeBps()).to.equal(150n);
  });
});

describe("ArcForgeBondingCurve", function () {
  it("quotes and executes buys and sells while collecting transparent fees", async function () {
    const platform = await deployPlatform();
    const { creator, trader, usdc, vault } = platform;
    const { token, curve } = await launch(platform);
    expect(await curve.creatorFeeRecipient()).to.equal(creator.address);
    expect(await curve.CREATOR_FEE_SHARE_BPS()).to.equal(7_000n);
    const amountIn = 1_000n * USDC;
    const [quotedTokens, buyFee] = await curve.quoteBuy(amountIn);
    expect(quotedTokens).to.be.greaterThan(0);
    expect(buyFee).to.equal(10n * USDC);

    const creatorBalanceBeforeBuy = await usdc.balanceOf(creator.address);
    await usdc.connect(trader).approve(await curve.getAddress(), amountIn);
    await expect(curve.connect(trader).buy(amountIn, quotedTokens))
      .to.emit(curve, "FeeSplit")
      .withArgs(trader.address, await curve.BUY_FEE(), creator.address, 7n * USDC, 3n * USDC);
    expect(await token.balanceOf(trader.address)).to.equal(quotedTokens);
    expect(await usdc.balanceOf(creator.address) - creatorBalanceBeforeBuy).to.equal(7n * USDC);
    expect(await vault.getFeeTotal(await usdc.getAddress(), ethers.keccak256(ethers.toUtf8Bytes("BUY_FEE"))))
      .to.equal(3n * USDC);

    const tokenIn = quotedTokens / 2n;
    const [quotedUsdc, sellFee] = await curve.quoteSell(tokenIn);
    const creatorBalanceBeforeSell = await usdc.balanceOf(creator.address);
    await token.connect(trader).approve(await curve.getAddress(), tokenIn);
    await expect(curve.connect(trader).sell(tokenIn, quotedUsdc)).to.emit(curve, "FeeSplit");
    expect(quotedUsdc).to.be.greaterThan(0);
    const expectedSellProtocolFee = sellFee * 3_000n / 10_000n;
    const expectedSellCreatorFee = sellFee - expectedSellProtocolFee;
    expect(await usdc.balanceOf(creator.address) - creatorBalanceBeforeSell).to.equal(expectedSellCreatorFee);
    expect(await vault.getFeeTotal(await usdc.getAddress(), ethers.keccak256(ethers.toUtf8Bytes("SELL_FEE"))))
      .to.equal(expectedSellProtocolFee);
    expect(await curve.totalCreatorFees()).to.equal(7n * USDC + expectedSellCreatorFee);
    expect(await curve.totalProtocolFees()).to.equal(3n * USDC + expectedSellProtocolFee);
  });

  it("enforces amount and slippage checks", async function () {
    const platform = await deployPlatform();
    const { trader, usdc } = platform;
    const { token, curve } = await launch(platform);
    await expect(curve.connect(trader).buy(0, 0)).to.be.revertedWithCustomError(curve, "ZeroAmount");
    const amount = 100n * USDC;
    const [quote] = await curve.quoteBuy(amount);
    await usdc.connect(trader).approve(await curve.getAddress(), amount);
    await expect(curve.connect(trader).buy(amount, quote + 1n)).to.be.revertedWithCustomError(curve, "SlippageExceeded");
    await expect(curve.connect(trader).sell(0, 0)).to.be.revertedWithCustomError(curve, "ZeroAmount");
    await expect(curve.connect(trader).sell(TOKEN, 0)).to.be.reverted;
    expect(await token.balanceOf(trader.address)).to.equal(0);
  });

  it("does not pay a whole USDC base unit for a dust token sale", async function () {
    const platform = await deployPlatform();
    const { trader, usdc } = platform;
    const { token, curve } = await launch(platform);
    const amount = 100n * USDC;
    const [tokensOut] = await curve.quoteBuy(amount);
    await usdc.connect(trader).approve(await curve.getAddress(), amount);
    await curve.connect(trader).buy(amount, tokensOut);

    const [dustOutput, dustFee] = await curve.quoteSell(1n);
    expect(dustOutput).to.equal(0);
    expect(dustFee).to.equal(0);
    await token.connect(trader).approve(await curve.getAddress(), 1n);
    await expect(curve.connect(trader).sell(1n, 0)).to.be.revertedWithCustomError(curve, "InsufficientLiquidity");
  });

  it("preserves reserve solvency and a non-decreasing invariant across randomized trades", async function () {
    const platform = await deployPlatform();
    const { trader, usdc } = platform;
    const { token, curve } = await launch(platform);
    const curveAddress = await curve.getAddress();
    await usdc.connect(trader).approve(curveAddress, ethers.MaxUint256);
    await token.connect(trader).approve(curveAddress, ethers.MaxUint256);

    let seed = 0xA11CEn;
    const nextRandom = () => {
      seed ^= seed << 13n;
      seed ^= seed >> 7n;
      seed ^= seed << 17n;
      return seed & ((1n << 64n) - 1n);
    };

    for (let iteration = 0; iteration < 32; iteration += 1) {
      const tokenReserveBefore = await curve.tokenReserve();
      const usdcReserveBefore = await curve.usdcReserve();
      const virtualReserve = await curve.virtualUsdcReserve();
      const invariantBefore = (virtualReserve + usdcReserveBefore) * tokenReserveBefore;
      const traderTokens = await token.balanceOf(trader.address);
      const shouldBuy = traderTokens === 0n || nextRandom() % 3n !== 0n;

      if (shouldBuy) {
        const amount = (nextRandom() % 200n + 1n) * USDC;
        const [quote] = await curve.quoteBuy(amount);
        expect(quote).to.be.greaterThan(0);
        await curve.connect(trader).buy(amount, quote);
      } else {
        const amount = traderTokens * (nextRandom() % 80n + 1n) / 100n;
        const [quote] = await curve.quoteSell(amount);
        if (quote > 0n) await curve.connect(trader).sell(amount, quote);
      }

      const tokenReserveAfter = await curve.tokenReserve();
      const usdcReserveAfter = await curve.usdcReserve();
      const invariantAfter = (virtualReserve + usdcReserveAfter) * tokenReserveAfter;
      expect(await token.balanceOf(curveAddress)).to.equal(tokenReserveAfter);
      expect(await usdc.balanceOf(curveAddress)).to.equal(usdcReserveAfter);
      expect(tokenReserveAfter).to.be.greaterThan(0);
      expect(invariantAfter).to.be.at.least(invariantBefore);
    }
  });

  it("caps pre-graduation input so a large buy cannot drain the token reserve", async function () {
    const platform = await deployPlatform();
    const { trader, usdc } = platform;
    const { curve } = await launch(platform);
    const maximum = await curve.maxBuyAmount();
    await usdc.connect(trader).approve(await curve.getAddress(), maximum + 1n);
    expect(await curve.quoteBuy(maximum + 1n)).to.deep.equal([0n, 0n]);
    await expect(curve.connect(trader).buy(maximum + 1n, 0))
      .to.be.revertedWithCustomError(curve, "GraduationThresholdExceeded")
      .withArgs(maximum);
    const [quote] = await curve.quoteBuy(maximum);
    expect(quote).to.be.greaterThan(0);
    await expect(curve.connect(trader).buy(maximum, quote)).to.emit(curve, "CurveGraduated");
    expect(await curve.tokenReserve()).to.be.greaterThan(0);
  });

  it("graduates into permanent real-reserve liquidity without a price discontinuity", async function () {
    const platform = await deployPlatform();
    const { trader, usdc } = platform;
    const { token, curve } = await launch(platform, {
      virtualUsdcReserve: 25n * USDC,
      graduationThreshold: 100n * USDC,
    });
    const maximum = await curve.maxBuyAmount();
    const [quote] = await curve.quoteBuy(maximum);
    const initialReserve = await curve.initialTokenReserve();
    await usdc.connect(trader).approve(await curve.getAddress(), maximum + 50n * USDC);
    const preGraduationTokenReserve = initialReserve - quote;
    const expectedPrice = (125n * USDC) * TOKEN / preGraduationTokenReserve;

    await expect(curve.connect(trader).buy(maximum, quote))
      .to.emit(curve, "PermanentLiquidityActivated");
    expect(await curve.isGraduated()).to.equal(true);
    expect(await curve.usdcReserve()).to.equal(100n * USDC);
    expect(await curve.getCurveProgress()).to.equal(10_000n);
    expect(await curve.tokensSold()).to.equal(quote);
    const lockedAtGraduation = await token.balanceOf(LIQUIDITY_LOCK);
    expect(lockedAtGraduation).to.be.greaterThan(0);
    expect(await token.balanceOf(await curve.getAddress())).to.equal(await curve.tokenReserve());
    expect(await curve.tokensSold() * 10_000n / initialReserve).to.be.closeTo(8_000n, 1n);

    const postGraduationPrice = await curve.getCurrentPrice();
    expect(postGraduationPrice).to.be.closeTo(expectedPrice, 1n);

    const postGraduationBuy = 10n * USDC;
    const [moreTokens] = await curve.quoteBuy(postGraduationBuy);
    await expect(curve.connect(trader).buy(postGraduationBuy, moreTokens)).to.emit(curve, "TokenBought");
    expect(moreTokens).to.be.greaterThan(0);

    const invariantBeforeSell = (await curve.usdcReserve()) * (await curve.tokenReserve());
    const tokensToSell = quote / 2n;
    const [usdcOut] = await curve.quoteSell(tokensToSell);
    await token.connect(trader).approve(await curve.getAddress(), tokensToSell);
    await expect(curve.connect(trader).sell(tokensToSell, usdcOut)).to.emit(curve, "TokenSold");
    expect(usdcOut).to.be.greaterThan(0);
    const invariantAfterSell = (await curve.usdcReserve()) * (await curve.tokenReserve());
    expect(invariantAfterSell).to.be.at.least(invariantBeforeSell);
    expect(await token.balanceOf(LIQUIDITY_LOCK)).to.equal(lockedAtGraduation);
    expect(await token.balanceOf(await curve.getAddress())).to.equal(await curve.tokenReserve());
  });

  it("keeps the permanent AMM solvent across post-graduation round trips", async function () {
    const platform = await deployPlatform();
    const { trader, usdc } = platform;
    const { token, curve } = await launch(platform);
    const maximum = await curve.maxBuyAmount();
    const [graduationQuote] = await curve.quoteBuy(maximum);
    await usdc.connect(trader).approve(await curve.getAddress(), maximum + 1_000n * USDC);
    await curve.connect(trader).buy(maximum, graduationQuote);

    const lockedAtGraduation = await token.balanceOf(LIQUIDITY_LOCK);
    for (let iteration = 0; iteration < 16; iteration += 1) {
      const buyAmount = BigInt(5 + iteration) * USDC;
      const [tokensOut] = await curve.quoteBuy(buyAmount);
      await curve.connect(trader).buy(buyAmount, tokensOut);
      const sellAmount = tokensOut / 2n;
      const [usdcOut] = await curve.quoteSell(sellAmount);
      await token.connect(trader).approve(await curve.getAddress(), sellAmount);
      await curve.connect(trader).sell(sellAmount, usdcOut);

      expect(await usdc.balanceOf(await curve.getAddress())).to.equal(await curve.usdcReserve());
      expect(await token.balanceOf(await curve.getAddress())).to.equal(await curve.tokenReserve());
      expect(await token.balanceOf(LIQUIDITY_LOCK)).to.equal(lockedAtGraduation);
    }
  });
});

describe("ArcForgeFeeVault", function () {
  it("records real fees, withdraws to the recipient, and rejects unauthorized withdrawals", async function () {
    const { owner, creator, recipient, stranger, usdc, vault } = await deployPlatform();
    const fee = 75n * USDC;
    const feeType = ethers.keccak256(ethers.toUtf8Bytes("TEST_FEE"));
    await usdc.connect(creator).approve(await vault.getAddress(), fee);
    await expect(vault.connect(creator).collectFee(await usdc.getAddress(), creator.address, feeType, fee))
      .to.emit(vault, "FeeReceived");
    await expect(vault.connect(stranger).withdraw(await usdc.getAddress(), fee))
      .to.be.revertedWithCustomError(vault, "Unauthorized");
    await expect(vault.connect(owner).withdraw(await usdc.getAddress(), fee)).to.emit(vault, "FeeWithdrawn");
    expect(await usdc.balanceOf(recipient.address)).to.equal(fee);
  });

  it("lets only the owner rotate the recipient and always withdraws to the active recipient", async function () {
    const { owner, creator, recipient, stranger, usdc, vault } = await deployPlatform();
    const fee = 10n * USDC;
    const feeType = ethers.keccak256(ethers.toUtf8Bytes("TEST_FEE"));
    await expect(vault.connect(stranger).setFeeRecipient(stranger.address))
      .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);
    await vault.connect(owner).setFeeRecipient(stranger.address);
    await usdc.connect(creator).approve(await vault.getAddress(), fee);
    await vault.connect(creator).collectFee(await usdc.getAddress(), creator.address, feeType, fee);
    await expect(vault.connect(recipient).withdraw(await usdc.getAddress(), fee))
      .to.be.revertedWithCustomError(vault, "Unauthorized");
    await vault.connect(stranger).withdraw(await usdc.getAddress(), fee);
    expect(await usdc.balanceOf(stranger.address)).to.equal(fee);
  });
});

describe("ArcForgeCreatorRegistry", function () {
  it("registers and lets a creator update metadata", async function () {
    const { creator, registry } = await deployPlatform();
    await expect(registry.connect(creator).registerCreator("ipfs://profile")).to.emit(registry, "CreatorRegistered");
    await expect(registry.connect(creator).updateCreatorMetadata("ipfs://profile-v2")).to.emit(registry, "CreatorUpdated");
    expect((await registry.getCreatorProfile(creator.address)).metadataURI).to.equal("ipfs://profile-v2");
  });

  it("allows only the owner to select the factory and only that factory to record launches", async function () {
    const { owner, creator, stranger, registry } = await deployPlatform();
    await expect(registry.connect(stranger).setFactory(stranger.address))
      .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
      .withArgs(stranger.address);
    await expect(registry.connect(creator).recordLaunch(creator.address, stranger.address))
      .to.be.revertedWithCustomError(registry, "Unauthorized");
    await registry.connect(owner).setFactory(stranger.address);
    await expect(registry.connect(stranger).recordLaunch(creator.address, stranger.address))
      .to.emit(registry, "CreatorLaunchRecorded")
      .withArgs(creator.address, stranger.address, 1);
  });
});
