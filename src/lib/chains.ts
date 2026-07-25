import { defineChain, isAddress, type Address } from "viem";

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

export const EXPLORER_URL = arcTestnet.blockExplorers.default.url;
export const ARC_TESTNET_FIRST_LAUNCH_BLOCK = 53_061_367n;
export const ARC_TESTNET_V2_FACTORY_BLOCK = 53_112_263n;
export const ARC_TESTNET_V3_FACTORY_BLOCK = 53_237_596n;
export const ARC_TESTNET_V4_FACTORY_BLOCK = 53_413_988n;
export const ARC_TESTNET_LEGACY_FACTORY = "0xA4DbA45B199287d3163199A86B4618968d8f8424" as Address;
export const ARC_TESTNET_V2_FACTORY = "0xc5FB127934782D5A147d5EE67Be741EC233036D2" as Address;
export const ARC_TESTNET_V3_FACTORY = "0x54382b7329FAB9BA0532f607b73027ee0AFB04Ba" as Address;
export const ARC_TESTNET_V4_FACTORY = "0x09e8b251392dc289e94B2242A12949aAbC722045" as Address;
export const ARCORIGIN_V4_GRADUATION_TARGET_USDC = 10_000;

function configuredAddress(value: string | undefined, fallback: Address): Address {
  return value && isAddress(value) ? value : fallback;
}

export const ARC_TESTNET_CONTRACTS = {
  factory: configuredAddress(
    process.env.NEXT_PUBLIC_FACTORY_ADDRESS,
    ARC_TESTNET_V4_FACTORY,
  ),
  feeVault: configuredAddress(
    process.env.NEXT_PUBLIC_FEE_VAULT_ADDRESS,
    "0x7bfcdA8108Db53B3cCAe02B29C6e5B3905950fB4",
  ),
  creatorRegistry: configuredAddress(
    process.env.NEXT_PUBLIC_CREATOR_REGISTRY_ADDRESS,
    "0x07287313ee649efcF22EAEE4361cd6c512219B61",
  ),
  usdc: configuredAddress(
    process.env.NEXT_PUBLIC_USDC_ADDRESS,
    "0x3600000000000000000000000000000000000000",
  ),
} as const;

const knownFactoryIndexes = [
  { address: ARC_TESTNET_V4_FACTORY, fromBlock: ARC_TESTNET_V4_FACTORY_BLOCK },
  { address: ARC_TESTNET_V3_FACTORY, fromBlock: ARC_TESTNET_V3_FACTORY_BLOCK },
  { address: ARC_TESTNET_V2_FACTORY, fromBlock: ARC_TESTNET_V2_FACTORY_BLOCK },
  { address: ARC_TESTNET_LEGACY_FACTORY, fromBlock: ARC_TESTNET_FIRST_LAUNCH_BLOCK },
] as const;

function factoryStartBlock(address: Address) {
  return knownFactoryIndexes.find((factory) => factory.address.toLowerCase() === address.toLowerCase())?.fromBlock
    ?? ARC_TESTNET_V4_FACTORY_BLOCK;
}

export const ARC_TESTNET_FACTORY_INDEXES = [
  {
    address: ARC_TESTNET_CONTRACTS.factory,
    fromBlock: factoryStartBlock(ARC_TESTNET_CONTRACTS.factory),
  },
  ...knownFactoryIndexes.filter(
    (factory) => factory.address.toLowerCase() !== ARC_TESTNET_CONTRACTS.factory.toLowerCase(),
  ),
] as const;

export function factoryForLaunchBlock(launchBlock?: number) {
  if (launchBlock === undefined) return ARC_TESTNET_CONTRACTS.factory;
  const block = BigInt(launchBlock);
  if (block >= ARC_TESTNET_V4_FACTORY_BLOCK) return ARC_TESTNET_V4_FACTORY;
  if (block >= ARC_TESTNET_V3_FACTORY_BLOCK) return ARC_TESTNET_V3_FACTORY;
  if (block >= ARC_TESTNET_V2_FACTORY_BLOCK) return ARC_TESTNET_V2_FACTORY;
  return ARC_TESTNET_LEGACY_FACTORY;
}

export const ARC_TESTNET_USDC = ARC_TESTNET_CONTRACTS.usdc;
