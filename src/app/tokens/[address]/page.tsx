import type { Metadata } from "next";
import { getAddress, isAddress } from "viem";
import { IndexedTokenDetail } from "@/components/indexed-token-detail";
import { getCachedBuybackSnapshot } from "@/lib/onchain/buyback-snapshot";
import { getCachedHolderSnapshot } from "@/lib/onchain/holder-snapshot";
import { getCachedMarketSnapshot } from "@/lib/onchain/market-snapshot";
import { getCachedTokenIndexSnapshot } from "@/lib/onchain/token-index-snapshot";

type Props = { params: Promise<{ address: string }> };

export const metadata: Metadata = { title: "Onchain Token" };
export const dynamic = "force-dynamic";

export default async function TokenDetailPage({ params }: Props) {
  const address = (await params).address;
  const normalizedAddress = isAddress(address) ? getAddress(address) : null;
  const [tokenIndex, initialMarketSnapshot, initialHolderSnapshot, initialBuybackSnapshot] = await Promise.all([
    getCachedTokenIndexSnapshot(),
    normalizedAddress ? getCachedMarketSnapshot(normalizedAddress) : null,
    normalizedAddress ? getCachedHolderSnapshot(normalizedAddress) : null,
    normalizedAddress ? getCachedBuybackSnapshot(normalizedAddress) : null,
  ]);
  const initialToken = normalizedAddress
    ? tokenIndex?.tokens.find(
      (token) => token.address.toLowerCase() === normalizedAddress.toLowerCase(),
    ) ?? null
    : null;
  return <IndexedTokenDetail
    address={address}
    initialToken={initialToken}
    initialMarketSnapshot={initialMarketSnapshot}
    initialHolderSnapshot={initialHolderSnapshot}
    initialBuybackSnapshot={initialBuybackSnapshot}
  />;
}
