import { defineChain, isAddress, type Address } from "viem";

export type ArcNetworkKey = "testnet" | "mainnet";

export const ARCORIGIN_NETWORK: ArcNetworkKey =
  process.env.NEXT_PUBLIC_ARC_NETWORK === "mainnet" ? "mainnet" : "testnet";
export const ARCORIGIN_PROTOCOL_VERSION =
  process.env.NEXT_PUBLIC_PROTOCOL_VERSION === "6" ? 6 : 5;

const mainnetRpcUrl = process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL?.trim() || "https://invalid.invalid";
const mainnetExplorerUrl =
  process.env.NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL?.trim() || "https://invalid.invalid";

export const arcTestnet = defineChain({
  id: 5_042_002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        "https://rpc.drpc.testnet.arc.network",
        "https://rpc.blockdaemon.testnet.arc.network",
        "https://rpc.quicknode.testnet.arc.network",
        "https://rpc.testnet.arc.network",
      ],
    },
  },
  blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

// Arc mainnet parameters are confirmed in Uniswap's Arc deployment playbook.
// The RPC and explorer remain explicit environment inputs so a stale or
// unofficial endpoint can never silently become a production dependency.
export const arcMainnet = defineChain({
  id: 5_042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [mainnetRpcUrl] } },
  blockExplorers: { default: { name: "Arc Explorer", url: mainnetExplorerUrl } },
});

export const arcChain = ARCORIGIN_NETWORK === "mainnet" ? arcMainnet : arcTestnet;
export const EXPLORER_URL = arcChain.blockExplorers.default.url;
export const EXPLORER_API_URL = ARCORIGIN_NETWORK === "mainnet"
  ? process.env.NEXT_PUBLIC_ARC_MAINNET_EXPLORER_API_URL?.trim() || null
  : process.env.NEXT_PUBLIC_ARC_TESTNET_EXPLORER_API_URL?.trim() || "https://testnet.arcscan.app/api";
export const ARC_OFFICIAL_USDC = "0x3600000000000000000000000000000000000000" as Address;
export const ARC_MAINNET_UNISWAP_V3_FACTORY =
  "0xf0db7b58379503491d857db50ac9ece64c653918" as Address;
export const ARC_MAINNET_UNISWAP_V3_POSITION_MANAGER =
  "0x39654a85a4c05127f5fd6ed22caec077a0fb1377" as Address;
export const ARC_MAINNET_UNISWAP_V3_QUOTER =
  "0x7dfd4f31be6814d2906bde155c3e1b146eac1468" as Address;
export const ARC_MAINNET_UNISWAP_V3_ROUTER =
  "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77" as Address;
export const ARC_MAINNET_DEPLOYMENT = {
  factory: "0x2dAED890c8920428e0215583aaC98332447a8170" as Address,
  feeVault: "0x07287313ee649efcF22EAEE4361cd6c512219B61" as Address,
  creatorRegistry: "0xA4DbA45B199287d3163199A86B4618968d8f8424" as Address,
  curveDeployer: "0xd7D2e4Ce4548330f52fc2F79F8524E6e32576013" as Address,
  migrationAdapter: "0xc3EF95C4afDe66537acC40011ED5c6e505126a21" as Address,
  liquidityLocker: "0xC41DA72afE97f8fbCA9722f893519cF2972cFb0e" as Address,
  migrationVerifier: "0xAA949a795CB1bCc15E4c1AA2DC18a548b9f483c9" as Address,
  originToken: "0xB65Fd34cc428492DdF000A2Ae100Dbfea62E4802" as Address,
  originCurve: "0x18708Bd06e264E8147065159C90460be4b5B5312" as Address,
  buybackController: "0x43ED0F9CD330FE8F093f2a0CE2FA05A155e7f746" as Address,
  governanceSafe: "0xa6eA2380F98700AD5CA8B9F74dC8861269513779" as Address,
} as const;

export const ARC_MAINNET_ORIGIN_POLICY = {
  symbol: "ORIGIN",
  buybackShareBps: 8_000,
  operationsShareBps: 2_000,
  maxChunkUsdc: 25,
  executionIntervalSeconds: 3_600,
  maxSlippageBps: 300,
  burnAddress: "0x000000000000000000000000000000000000dEaD" as Address,
  activationTransaction:
    "0x1e97a067b2382b2fc345c852538208d52d46471ccdd750e00b0d44bba282ccf0",
} as const;

export function isOfficialOriginToken(address: string) {
  return (
    ARCORIGIN_NETWORK === "mainnet" &&
    address.toLowerCase() === ARC_MAINNET_DEPLOYMENT.originToken.toLowerCase()
  );
}

export const ARC_TESTNET_FIRST_LAUNCH_BLOCK = 53_061_367n;
export const ARC_TESTNET_V2_FACTORY_BLOCK = 53_112_263n;
export const ARC_TESTNET_V3_FACTORY_BLOCK = 53_237_596n;
export const ARC_TESTNET_V4_FACTORY_BLOCK = 53_413_988n;
export const ARC_TESTNET_V5_FACTORY_BLOCK = 53_751_918n;
export const ARC_TESTNET_LEGACY_FACTORY = "0xA4DbA45B199287d3163199A86B4618968d8f8424" as Address;
export const ARC_TESTNET_V2_FACTORY = "0xc5FB127934782D5A147d5EE67Be741EC233036D2" as Address;
export const ARC_TESTNET_V3_FACTORY = "0x54382b7329FAB9BA0532f607b73027ee0AFB04Ba" as Address;
export const ARC_TESTNET_V4_FACTORY = "0x09e8b251392dc289e94B2242A12949aAbC722045" as Address;
export const ARC_TESTNET_V5_FACTORY = "0x7a0FB240bcB691555A51DE238aAA3a58c1DB337c" as Address;
export const ARCORIGIN_V4_GRADUATION_TARGET_USDC = 10_000;
export const ARCORIGIN_ACTIVE_GRADUATION_TARGET_USDC = 10_000;

function configuredAddress(
  value: string | undefined,
  fallback: Address | undefined,
  label: string,
): Address {
  if (value && isAddress(value) && value !== "0x0000000000000000000000000000000000000000") {
    return value;
  }
  if (fallback && isAddress(fallback)) return fallback;
  throw new Error(`${label} must be configured as a non-zero contract address.`);
}

function configuredFactoryBlock(value: string | undefined) {
  if (ARCORIGIN_NETWORK === "testnet" && ARCORIGIN_PROTOCOL_VERSION !== 6) {
    return ARC_TESTNET_V5_FACTORY_BLOCK;
  }
  if (!value || !/^\d+$/.test(value)) {
    throw new Error("The active Factory deployment block must be configured.");
  }
  const block = BigInt(value);
  if (
    block <= 0n ||
    (ARCORIGIN_NETWORK === "testnet" && block <= ARC_TESTNET_V5_FACTORY_BLOCK)
  ) {
    throw new Error("The active Factory deployment block is invalid for the selected Arc network.");
  }
  return block;
}

if (ARCORIGIN_NETWORK === "mainnet") {
  if (ARCORIGIN_PROTOCOL_VERSION !== 6) {
    throw new Error("Arc mainnet can only be built with Protocol V6.");
  }
  if (!process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL || !process.env.NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL) {
    throw new Error("Arc mainnet RPC and explorer URLs must be explicitly configured.");
  }
}

export const ARC_ACTIVE_FACTORY = configuredAddress(
  ARCORIGIN_NETWORK === "mainnet"
    ? process.env.NEXT_PUBLIC_MAINNET_FACTORY_ADDRESS
    : process.env.NEXT_PUBLIC_FACTORY_ADDRESS,
  ARCORIGIN_NETWORK === "testnet" && ARCORIGIN_PROTOCOL_VERSION !== 6
    ? ARC_TESTNET_V5_FACTORY
    : undefined,
  ARCORIGIN_NETWORK === "mainnet"
    ? "NEXT_PUBLIC_MAINNET_FACTORY_ADDRESS"
    : "NEXT_PUBLIC_FACTORY_ADDRESS",
);
export const ARC_ACTIVE_FACTORY_BLOCK = configuredFactoryBlock(
  ARCORIGIN_NETWORK === "mainnet"
    ? process.env.NEXT_PUBLIC_MAINNET_FACTORY_FROM_BLOCK
    : process.env.NEXT_PUBLIC_FACTORY_FROM_BLOCK,
);

export const ARC_ACTIVE_CONTRACTS = {
  factory: ARC_ACTIVE_FACTORY,
  feeVault: configuredAddress(
    ARCORIGIN_NETWORK === "mainnet"
      ? process.env.NEXT_PUBLIC_MAINNET_FEE_VAULT_ADDRESS
      : process.env.NEXT_PUBLIC_FEE_VAULT_ADDRESS,
    ARCORIGIN_NETWORK === "testnet" && ARCORIGIN_PROTOCOL_VERSION !== 6
      ? "0x7bfcdA8108Db53B3cCAe02B29C6e5B3905950fB4"
      : undefined,
    ARCORIGIN_NETWORK === "mainnet"
      ? "NEXT_PUBLIC_MAINNET_FEE_VAULT_ADDRESS"
      : "NEXT_PUBLIC_FEE_VAULT_ADDRESS",
  ),
  creatorRegistry: configuredAddress(
    ARCORIGIN_NETWORK === "mainnet"
      ? process.env.NEXT_PUBLIC_MAINNET_CREATOR_REGISTRY_ADDRESS
      : process.env.NEXT_PUBLIC_CREATOR_REGISTRY_ADDRESS,
    ARCORIGIN_NETWORK === "testnet" && ARCORIGIN_PROTOCOL_VERSION !== 6
      ? "0x07287313ee649efcF22EAEE4361cd6c512219B61"
      : undefined,
    ARCORIGIN_NETWORK === "mainnet"
      ? "NEXT_PUBLIC_MAINNET_CREATOR_REGISTRY_ADDRESS"
      : "NEXT_PUBLIC_CREATOR_REGISTRY_ADDRESS",
  ),
  usdc: configuredAddress(
    ARCORIGIN_NETWORK === "mainnet"
      ? process.env.NEXT_PUBLIC_MAINNET_USDC_ADDRESS
      : process.env.NEXT_PUBLIC_USDC_ADDRESS,
    ARC_OFFICIAL_USDC,
    ARCORIGIN_NETWORK === "mainnet"
      ? "NEXT_PUBLIC_MAINNET_USDC_ADDRESS"
      : "NEXT_PUBLIC_USDC_ADDRESS",
  ),
} as const;

function configuredOfficialAddress(
  value: string | undefined,
  expected: Address,
  label: string,
) {
  const configured = configuredAddress(value, undefined, label);
  if (configured.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} does not match the reviewed official Arc deployment.`);
  }
  return configured;
}

export const ARC_UNISWAP_V3 = ARCORIGIN_NETWORK === "mainnet"
  ? {
      factory: configuredOfficialAddress(
        process.env.NEXT_PUBLIC_UNISWAP_V3_FACTORY,
        ARC_MAINNET_UNISWAP_V3_FACTORY,
        "NEXT_PUBLIC_UNISWAP_V3_FACTORY",
      ),
      positionManager: configuredOfficialAddress(
        process.env.NEXT_PUBLIC_UNISWAP_V3_POSITION_MANAGER,
        ARC_MAINNET_UNISWAP_V3_POSITION_MANAGER,
        "NEXT_PUBLIC_UNISWAP_V3_POSITION_MANAGER",
      ),
      quoter: configuredOfficialAddress(
        process.env.NEXT_PUBLIC_UNISWAP_V3_QUOTER,
        ARC_MAINNET_UNISWAP_V3_QUOTER,
        "NEXT_PUBLIC_UNISWAP_V3_QUOTER",
      ),
      router: configuredOfficialAddress(
        process.env.NEXT_PUBLIC_UNISWAP_V3_ROUTER,
        ARC_MAINNET_UNISWAP_V3_ROUTER,
        "NEXT_PUBLIC_UNISWAP_V3_ROUTER",
      ),
      fee: 10_000,
    } as const
  : null;

if (ARC_ACTIVE_CONTRACTS.usdc.toLowerCase() !== ARC_OFFICIAL_USDC.toLowerCase()) {
  throw new Error("The selected Arc deployment must use the canonical 6-decimal USDC predeploy.");
}

const knownTestnetFactoryIndexes = [
  { address: ARC_TESTNET_V5_FACTORY, fromBlock: ARC_TESTNET_V5_FACTORY_BLOCK },
  { address: ARC_TESTNET_V4_FACTORY, fromBlock: ARC_TESTNET_V4_FACTORY_BLOCK },
  { address: ARC_TESTNET_V3_FACTORY, fromBlock: ARC_TESTNET_V3_FACTORY_BLOCK },
  { address: ARC_TESTNET_V2_FACTORY, fromBlock: ARC_TESTNET_V2_FACTORY_BLOCK },
  { address: ARC_TESTNET_LEGACY_FACTORY, fromBlock: ARC_TESTNET_FIRST_LAUNCH_BLOCK },
] as const;

export const ARC_ACTIVE_FACTORY_INDEXES = [
  { address: ARC_ACTIVE_FACTORY, fromBlock: ARC_ACTIVE_FACTORY_BLOCK },
  ...(ARCORIGIN_NETWORK === "testnet" && ARCORIGIN_PROTOCOL_VERSION !== 6
    ? knownTestnetFactoryIndexes.filter(
      (factory) => factory.address.toLowerCase() !== ARC_ACTIVE_FACTORY.toLowerCase(),
    )
    : []),
] as const;

export function factoryForLaunchBlock(launchBlock?: number) {
  if (ARCORIGIN_NETWORK === "mainnet" || ARCORIGIN_PROTOCOL_VERSION === 6) {
    return ARC_ACTIVE_FACTORY;
  }
  if (launchBlock === undefined) return ARC_ACTIVE_FACTORY;
  const block = BigInt(launchBlock);
  if (block >= ARC_TESTNET_V5_FACTORY_BLOCK) return ARC_TESTNET_V5_FACTORY;
  if (block >= ARC_TESTNET_V4_FACTORY_BLOCK) return ARC_TESTNET_V4_FACTORY;
  if (block >= ARC_TESTNET_V3_FACTORY_BLOCK) return ARC_TESTNET_V3_FACTORY;
  if (block >= ARC_TESTNET_V2_FACTORY_BLOCK) return ARC_TESTNET_V2_FACTORY;
  return ARC_TESTNET_LEGACY_FACTORY;
}

export const ARC_USDC = ARC_ACTIVE_CONTRACTS.usdc;

export function usesV6Transactions(factoryAddress?: string) {
  return (
    ARCORIGIN_PROTOCOL_VERSION === 6 &&
    Boolean(factoryAddress) &&
    factoryAddress?.toLowerCase() === ARC_ACTIVE_FACTORY.toLowerCase()
  );
}
