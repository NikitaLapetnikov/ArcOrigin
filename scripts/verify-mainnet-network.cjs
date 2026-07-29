const hre = require("hardhat");

const ARC_MAINNET_CHAIN_ID = 5_042n;
const DEFAULT_RPC_URL = "https://rpc.blockdaemon.mainnet.arc.io";
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const POOL_FEE = 10_000;

const contracts = Object.freeze({
  usdc: {
    address: ARC_USDC,
    codeHash: "0xc9987bd3af6b26a030951faa7eacc017b68343aeedf3ce5fe68f821c4b93939d",
  },
  uniswapV3Factory: {
    address: "0xf0db7b58379503491d857db50ac9ece64c653918",
    codeHash: "0x621c4819f7b62d7ddb153206bc30950bcc3f5cc9d24c45661f8c2f31dcbd166d",
  },
  uniswapV3PositionManager: {
    address: "0x39654a85a4c05127f5fd6ed22caec077a0fb1377",
    codeHash: "0xcad0552151ba7675afe512ebe77fcc6eed68a0cb65775d31e38d44823e6796a0",
  },
  uniswapV3Quoter: {
    address: "0x7dfd4f31be6814d2906bde155c3e1b146eac1468",
    codeHash: "0xf222999269407743c526ee7c9d0c9b4fabec26773d48fd6fd257c5ebca976ea7",
  },
  uniswapV3SwapRouter: {
    address: "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77",
    codeHash: "0xc53680bc70e67f7e8818a0e1302e9b70a4460493bc6dd6db056575b17cb3af25",
  },
});

const erc20MetadataAbi = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const positionManagerAbi = ["function factory() view returns (address)"];
const v3FactoryAbi = ["function feeAmountTickSpacing(uint24 fee) view returns (int24)"];

function assertEqual(label, actual, expected) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: expected ${expected}, received ${actual}.`);
  }
}

async function main() {
  const rpcUrl = process.env.ARC_MAINNET_RPC_URL?.trim() || DEFAULT_RPC_URL;
  const provider = new hre.ethers.JsonRpcProvider(
    rpcUrl,
    Number(ARC_MAINNET_CHAIN_ID),
    { staticNetwork: true },
  );
  const [network, blockNumber] = await Promise.all([
    provider.getNetwork(),
    provider.getBlockNumber(),
  ]);
  assertEqual("Arc mainnet chain ID", network.chainId, ARC_MAINNET_CHAIN_ID);

  const codeHashes = {};
  for (const [name, expected] of Object.entries(contracts)) {
    const code = await provider.getCode(expected.address);
    if (code === "0x") {
      throw new Error(`${name} has no runtime bytecode at ${expected.address}.`);
    }
    const codeHash = hre.ethers.keccak256(code);
    assertEqual(`${name} runtime bytecode`, codeHash, expected.codeHash);
    codeHashes[name] = codeHash;
  }

  const usdc = new hre.ethers.Contract(ARC_USDC, erc20MetadataAbi, provider);
  const positionManager = new hre.ethers.Contract(
    contracts.uniswapV3PositionManager.address,
    positionManagerAbi,
    provider,
  );
  const factory = new hre.ethers.Contract(
    contracts.uniswapV3Factory.address,
    v3FactoryAbi,
    provider,
  );
  const [decimals, symbol, managerFactory, tickSpacing] = await Promise.all([
    usdc.decimals(),
    usdc.symbol(),
    positionManager.factory(),
    factory.feeAmountTickSpacing(POOL_FEE),
  ]);

  assertEqual("Arc USDC decimals", decimals, 6);
  assertEqual("Arc USDC symbol", symbol, "USDC");
  assertEqual(
    "Uniswap V3 PositionManager factory",
    managerFactory,
    contracts.uniswapV3Factory.address,
  );
  if (tickSpacing <= 0n) {
    throw new Error("Uniswap V3 1% fee tier is not enabled.");
  }

  console.log(JSON.stringify({
    ready: true,
    checkedAt: new Date().toISOString(),
    rpcUrl,
    chainId: Number(network.chainId),
    blockNumber,
    explorer: "https://arc-mainnet.cloud.blockscout.com",
    usdc: {
      address: ARC_USDC,
      decimals: Number(decimals),
      symbol,
    },
    uniswapV3: {
      factory: contracts.uniswapV3Factory.address,
      positionManager: contracts.uniswapV3PositionManager.address,
      quoter: contracts.uniswapV3Quoter.address,
      swapRouter: contracts.uniswapV3SwapRouter.address,
      poolFee: POOL_FEE,
      tickSpacing: Number(tickSpacing),
    },
    codeHashes,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
