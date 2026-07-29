import { legacyGenesisToken } from "@/lib/onchain/legacy-genesis";
import { ARC_TESTNET_V4_FACTORY } from "@/lib/chains";
import type { RiskLabel, TokenData } from "@/lib/types";

const creator = "0x2807B95E05649b7Befe74C4061f9492C5b889A42";
const riskLabels: RiskLabel[] = [
  "fixed_supply",
  "standard_template",
  "no_blacklist",
  "no_hidden_mint",
  "creator_allocation_low",
  "creator_allocation_visible",
  "missing_socials",
  "new_creator",
];

type BootstrapLaunch = {
  name: string;
  ticker: string;
  icon: string;
  address: string;
  curveAddress: string;
  launchTxHash: string;
  launchBlock: number;
  launchedAt: number;
  description: string;
  image?: string;
  metadataURI?: string;
  factoryAddress?: string;
  creatorAllocationPercent?: number;
  virtualUsdcReserve?: number;
  targetUSDC?: number;
};

function ageMinutes(launchedAt: number) {
  return Math.max(0, Math.floor((Date.now() / 1_000 - launchedAt) / 60));
}

function createBootstrapToken(launch: BootstrapLaunch): TokenData {
  const creatorAllocationPercent = launch.creatorAllocationPercent ?? 5;
  const virtualUsdcReserve = launch.virtualUsdcReserve ?? 10_000;
  const targetUSDC = launch.targetUSDC ?? 50_000;
  const initialTokenReserve = 1_000_000_000 * (1 - creatorAllocationPercent / 100);
  const price = virtualUsdcReserve / initialTokenReserve;
  return {
    ...launch,
    creator,
    source: "onchain",
    creatorAllocationPercent,
    totalSupply: 1_000_000_000,
    virtualUsdcReserve,
    ageMinutes: ageMinutes(launch.launchedAt),
    price,
    priceChange24h: 0,
    marketCap: price * 1_000_000_000,
    raisedUSDC: 0,
    targetUSDC,
    volume5m: 0,
    volume1h: 0,
    volume24h: 0,
    buyers: 0,
    sellers: 0,
    trades: 0,
    holders: 0,
    curveProgress: 0,
    riskScore: 79,
    status: "Live on curve",
    chartData: [{ time: "Launch", timestamp: launch.launchedAt, price, volume: 0 }],
    recentTrades: [],
    riskLabels,
    creatorProfile: {
      address: creator,
      reputation: 55,
      launches: 3,
      graduated: 0,
      flagged: 0,
      totalVolume: 0,
      totalFees: 25,
      verified: false,
    },
    socials: {},
  };
}

/**
 * Last-known, verified Factory launches used only for the first render.
 * The live Arcscan/Multicall index replaces this list as soon as it arrives.
 * Keeping the immutable launch data in the bundle prevents a slow public RPC
 * from making the Markets page look empty.
 */
export function getVerifiedBootstrapTokens(): TokenData[] {
  return [
    createBootstrapToken({
      name: "Sherlok",
      ticker: "SHERLOK",
      icon: "SH",
      image: "https://ipfs.io/ipfs/bafkreigdlvkn3xiunoqdec2qcpcpfu6veyyjiq7nhr4lw5ceip522j6qx4",
      metadataURI: "ipfs://bafkreiftk3j2kwrioeipgxnjn2uvdst6664nmkgv3caxqws6q3tpvnv3e4",
      address: "0xf499c61eb11871a0811490b79ac6bb6269a96478",
      curveAddress: "0xc620b06631a09b16e972a1a3b9f6a6c0d33e699e",
      factoryAddress: ARC_TESTNET_V4_FACTORY,
      launchTxHash: "0x516a17f86f466df9b6a9f77cb519562fadbe6e6c7a9f5e582b8eae2f484111a0",
      launchBlock: 53_442_199,
      launchedAt: 1_784_907_769,
      description: "Cat Sherlok",
      creatorAllocationPercent: 5,
      virtualUsdcReserve: 2_500,
      targetUSDC: 10_000,
    }),
    createBootstrapToken({
      name: "Sherlok",
      ticker: "SHERLOK",
      icon: "SH",
      image: "https://ipfs.io/ipfs/bafkreigdlvkn3xiunoqdec2qcpcpfu6veyyjiq7nhr4lw5ceip522j6qx4",
      metadataURI: "ipfs://bafkreihnswljruxg7t4buwnjin7k436vlq644qej5b52uotve3c7stxthe",
      address: "0xd6EEb4F3787744673ceBAc0Eed67577f7b825aAb",
      curveAddress: "0xd051BDb097493e645b76983C2B058fd8C7CC1b33",
      launchTxHash: "0x82af51972b0d9dea545f2971aa6191fdea5fdf413c8d669653d287e2c745017f",
      launchBlock: 53_225_019,
      launchedAt: 1_784_795_934,
      description: "Black cat Sherlok mur",
    }),
    createBootstrapToken({
      name: "ArcOrigin Production Test",
      ticker: "AOPT",
      icon: "AP",
      address: "0x15A2F7dddF8A1aaa341566E95552F801A6F6274f",
      curveAddress: "0x50bCddBB3Ed76565EaCc42aAebf49d06cf18a227",
      launchTxHash: "0x3cf731021194e4596fb751d18bc9541f83d06ff5711cff741f5416efc732a970",
      launchBlock: 53_091_112,
      launchedAt: 1_784_727_728,
      description: "ArcOrigin factory launch indexed from confirmed Arc events.",
    }),
    {
      ...legacyGenesisToken,
      launchedAt: 1_784_712_517,
      ageMinutes: ageMinutes(1_784_712_517),
      chartData: [{ time: "Launch", timestamp: 1_784_712_517, price: legacyGenesisToken.price, volume: 0 }],
      creatorProfile: {
        ...legacyGenesisToken.creatorProfile,
        launches: 3,
      },
    },
  ];
}
