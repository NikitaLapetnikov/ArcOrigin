require("dotenv").config({ quiet: true });
require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 500 } },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    arcMainnet: {
      // No public fallback: deployment must use a reviewed, dedicated endpoint.
      url: process.env.ARC_MAINNET_RPC_URL || "http://127.0.0.1:1",
      chainId: 5042,
      accounts: process.env.MAINNET_DEPLOYER_PRIVATE_KEY
        ? [process.env.MAINNET_DEPLOYER_PRIVATE_KEY]
        : [],
    },
  },
};
