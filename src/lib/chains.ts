import { defineChain, isAddress, type Address } from "viem";

export const ARCORIGIN_NETWORK = "mainnet" as const;
const mainnetRpcUrl = process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL?.trim() || "https://invalid.invalid";
const mainnetRpcFallbackUrls = (process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_FALLBACK_URLS ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const mainnetRpcUrls = [...new Set([mainnetRpcUrl, ...mainnetRpcFallbackUrls])] as [string, ...string[]];
const mainnetExplorerUrl = process.env.NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL?.trim() || "https://invalid.invalid";

export const arcMainnet = defineChain({
  id: 5_042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: mainnetRpcUrls } },
  blockExplorers: { default: { name: "Arc Explorer", url: mainnetExplorerUrl } },
});

export const arcChain = arcMainnet;
export const EXPLORER_URL = arcChain.blockExplorers.default.url;
export const EXPLORER_API_URL = process.env.NEXT_PUBLIC_ARC_MAINNET_EXPLORER_API_URL?.trim() || null;

export const ARC_OFFICIAL_USDC = "0x3600000000000000000000000000000000000000" as Address;
export const ARC_OFFICIAL_ORIGIN_TOKEN = "0xce9C0e29f8D5904bFAc3C8a79A0c9af00e6bDCcB" as Address;
export const ARC_MAINNET_UNISWAP_V3_FACTORY = "0xf0db7b58379503491d857db50ac9ece64c653918" as Address;
export const ARC_MAINNET_UNISWAP_V3_POSITION_MANAGER = "0x39654a85a4c05127f5fd6ed22caec077a0fb1377" as Address;
export const ARC_MAINNET_UNISWAP_V3_QUOTER = "0x7dfd4f31be6814d2906bde155c3e1b146eac1468" as Address;
export const ARC_MAINNET_UNISWAP_V3_ROUTER = "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77" as Address;
export const ARCORIGIN_START_MARKET_CAP_USDC = 5_000;
export const ARCORIGIN_CROSS_MARKET_CAP_USDC = 50_000;

function configuredAddress(value: string | undefined, fallback: Address | undefined, label: string): Address {
  if (value && isAddress(value) && value !== "0x0000000000000000000000000000000000000000") return value;
  if (fallback) return fallback;
  throw new Error(`${label} must be configured as a non-zero contract address.`);
}

function configuredBlock(value: string | undefined) {
  if (!value || !/^\d+$/.test(value) || BigInt(value) <= 0n) throw new Error("The active Factory deployment block must be configured.");
  return BigInt(value);
}

if (!process.env.NEXT_PUBLIC_ARC_MAINNET_RPC_URL || !process.env.NEXT_PUBLIC_ARC_MAINNET_EXPLORER_URL) {
  throw new Error("Arc mainnet RPC and explorer URLs must be explicitly configured.");
}

export const ARC_ACTIVE_FACTORY = configuredAddress(
  process.env.NEXT_PUBLIC_MAINNET_FACTORY_ADDRESS,
  undefined,
  "Factory address",
);
export const ARC_ACTIVE_FACTORY_BLOCK = configuredBlock(
  process.env.NEXT_PUBLIC_MAINNET_FACTORY_FROM_BLOCK,
);
export const ARC_ACTIVE_CONTRACTS = {
  factory: ARC_ACTIVE_FACTORY,
  feeVault: configuredAddress(
    process.env.NEXT_PUBLIC_MAINNET_FEE_VAULT_ADDRESS,
    undefined,
    "FeeVault address",
  ),
  creatorRegistry: configuredAddress(
    process.env.NEXT_PUBLIC_MAINNET_CREATOR_REGISTRY_ADDRESS,
    undefined,
    "CreatorRegistry address",
  ),
  usdc: configuredAddress(
    process.env.NEXT_PUBLIC_MAINNET_USDC_ADDRESS,
    ARC_OFFICIAL_USDC,
    "USDC address",
  ),
} as const;
if (ARC_ACTIVE_CONTRACTS.usdc.toLowerCase() !== ARC_OFFICIAL_USDC.toLowerCase()) throw new Error("ArcOrigin requires canonical Arc USDC.");

function uniswapAddress(name: string, officialMainnetAddress: Address): Address {
  const configured = configuredAddress(
    process.env[name],
    officialMainnetAddress,
    name,
  );
  if (configured.toLowerCase() !== officialMainnetAddress.toLowerCase()) {
    throw new Error(`${name} does not match the official Arc deployment.`);
  }
  return configured;
}

export const ARC_UNISWAP_V3 = {
  factory: uniswapAddress("NEXT_PUBLIC_UNISWAP_V3_FACTORY", ARC_MAINNET_UNISWAP_V3_FACTORY),
  positionManager: uniswapAddress("NEXT_PUBLIC_UNISWAP_V3_POSITION_MANAGER", ARC_MAINNET_UNISWAP_V3_POSITION_MANAGER),
  quoter: uniswapAddress("NEXT_PUBLIC_UNISWAP_V3_QUOTER", ARC_MAINNET_UNISWAP_V3_QUOTER),
  router: uniswapAddress("NEXT_PUBLIC_UNISWAP_V3_ROUTER", ARC_MAINNET_UNISWAP_V3_ROUTER),
  fee: 10_000,
} as const;
export const ARC_ACTIVE_FACTORY_INDEXES = [{ address: ARC_ACTIVE_FACTORY, fromBlock: ARC_ACTIVE_FACTORY_BLOCK }] as const;
export function factoryForLaunchBlock() { return ARC_ACTIVE_FACTORY; }

export function isOfficialOriginToken(address: string) {
  return ARC_OFFICIAL_ORIGIN_TOKEN?.toLowerCase() === address.toLowerCase();
}
