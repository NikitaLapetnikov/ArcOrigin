const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const describeFork = process.env.ARC_MAINNET_FORK_URL ? describe : describe.skip;
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const GOVERNANCE_SAFE = "0xa6eA2380F98700AD5CA8B9F74dC8861269513779";
const FEE_VAULT = "0x07287313ee649efcF22EAEE4361cd6c512219B61";
const CREATOR_REGISTRY = "0xA4DbA45B199287d3163199A86B4618968d8f8424";
const V3_FACTORY = "0xf0db7b58379503491d857db50ac9ece64c653918";
const POSITION_MANAGER = "0x39654a85a4c05127f5fd6ed22caec077a0fb1377";
const QUOTER = "0x7dfd4f31be6814d2906bde155c3e1b146eac1468";
const ROUTER = "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77";
const POOL_FEE = 10_000;
const USDC = 10n ** 6n;

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];

describeFork("ArcOrigin Arc mainnet fork integration", function () {
  this.timeout(240_000);

  before(async function () {
    await network.provider.request({
      method: "hardhat_reset",
      params: [{ forking: { jsonRpcUrl: process.env.ARC_MAINNET_FORK_URL } }],
    });
  });

  it("launches and trades canonical pools for both address orderings", async function () {
    const [, creator, trader, feeCaller] = await ethers.getSigners();
    // Arc USDC calls a chain-native precompile that Hardhat cannot emulate.
    // Preserve its canonical address while substituting standard ERC-20 runtime
    // for fork-only Router and PositionManager integration coverage.
    const MockUsdc = await ethers.getContractFactory("MockUSDC");
    const mockUsdc = await MockUsdc.deploy();
    await mockUsdc.waitForDeployment();
    await network.provider.send("hardhat_setCode", [
      ARC_USDC,
      await ethers.provider.getCode(await mockUsdc.getAddress()),
    ]);
    await network.provider.send("hardhat_setBalance", [
      GOVERNANCE_SAFE,
      "0x3635c9adc5dea00000",
    ]);
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [GOVERNANCE_SAFE],
    });
    const safeSigner = await ethers.getSigner(GOVERNANCE_SAFE);

    const Factory = await ethers.getContractFactory("ArcForgeFactory");
    const factory = await Factory.deploy(
      GOVERNANCE_SAFE,
      GOVERNANCE_SAFE,
      ARC_USDC,
      FEE_VAULT,
      CREATOR_REGISTRY,
      V3_FACTORY,
      POSITION_MANAGER,
      0,
    );
    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();
    const vault = new ethers.Contract(
      FEE_VAULT,
      [
        "function setRegistrar(address,bool)",
        "function setCollector(address,bool)",
      ],
      safeSigner,
    );
    const registry = new ethers.Contract(
      CREATOR_REGISTRY,
      ["function setFactory(address)"],
      safeSigner,
    );
    await (await vault.setRegistrar(factoryAddress, true)).wait();
    await (await vault.setCollector(factoryAddress, true)).wait();
    await (await registry.setFactory(factoryAddress)).wait();
    await (await factory.connect(safeSigner).unpauseLaunches()).wait();

    const launches = new Map();
    for (let index = 0; index < 32 && launches.size < 2; index += 1) {
      const receipt = await (
        await factory.connect(creator).launchToken({
          name: `Fork Launch ${index}`,
          symbol: `F${index}`,
          metadataURI: `ipfs://fork-${index}`,
        }, { gasLimit: 15_000_000 })
      ).wait();
      const event = receipt.logs
        .map((log) => {
          try {
            return factory.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((entry) => entry?.name === "TokenLaunched");
      const token = event.args.token;
      const tokenIsToken0 = BigInt(token) < BigInt(ARC_USDC);
      if (!launches.has(tokenIsToken0)) {
        launches.set(tokenIsToken0, {
          token,
          pool: event.args.pool,
          positionId: event.args.positionId,
        });
      }
    }
    expect(launches.size).to.equal(2);

    const usdc = new ethers.Contract(ARC_USDC, erc20Abi, trader);
    const usdcMinter = new ethers.Contract(
      ARC_USDC,
      ["function mint(address,uint256)"],
      creator,
    );
    await (await usdcMinter.mint(trader.address, 4n * USDC)).wait();
    await (await usdc.approve(ROUTER, 4n * USDC)).wait();
    const router = new ethers.Contract(
      ROUTER,
      [
        "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
      ],
      trader,
    );
    const quoter = new ethers.Contract(
      QUOTER,
      [
        "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
      ],
      trader,
    );
    const positionManager = new ethers.Contract(
      POSITION_MANAGER,
      ["function ownerOf(uint256) view returns (address)"],
      ethers.provider,
    );
    const lockerAddress = await factory.liquidityLocker();
    const locker = await ethers.getContractAt(
      "ArcOriginUniswapV3LiquidityLocker",
      lockerAddress,
    );

    for (const launch of launches.values()) {
      expect(await positionManager.ownerOf(launch.positionId)).to.equal(lockerAddress);
      const token = new ethers.Contract(launch.token, erc20Abi, trader);
      const quotedBuy = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: ARC_USDC,
        tokenOut: launch.token,
        amountIn: USDC,
        fee: POOL_FEE,
        sqrtPriceLimitX96: 0,
      });
      expect(quotedBuy.amountOut > 0n).to.equal(true);
      await (await router.exactInputSingle({
        tokenIn: ARC_USDC,
        tokenOut: launch.token,
        fee: POOL_FEE,
        recipient: trader.address,
        amountIn: USDC,
        amountOutMinimum: quotedBuy.amountOut * 99n / 100n,
        sqrtPriceLimitX96: 0,
      }, { gasLimit: 5_000_000 })).wait();
      const bought = await token.balanceOf(trader.address);
      expect(bought > 0n).to.equal(true);

      const sellAmount = bought / 2n;
      await (await token.approve(ROUTER, sellAmount)).wait();
      const quotedSell = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: launch.token,
        tokenOut: ARC_USDC,
        amountIn: sellAmount,
        fee: POOL_FEE,
        sqrtPriceLimitX96: 0,
      });
      expect(quotedSell.amountOut > 0n).to.equal(true);
      await (await router.exactInputSingle({
        tokenIn: launch.token,
        tokenOut: ARC_USDC,
        fee: POOL_FEE,
        recipient: trader.address,
        amountIn: sellAmount,
        amountOutMinimum: quotedSell.amountOut * 99n / 100n,
        sqrtPriceLimitX96: 0,
      }, { gasLimit: 5_000_000 })).wait();
      const feeReceipt = await (
        await locker.connect(feeCaller).collectFees(launch.positionId)
      ).wait();
      const feeEvent = feeReceipt.logs.some((log) => {
        try {
          return locker.interface.parseLog(log)?.name === "FeesClaimed";
        } catch {
          return false;
        }
      });
      expect(feeEvent).to.equal(true);
    }
  });
});
