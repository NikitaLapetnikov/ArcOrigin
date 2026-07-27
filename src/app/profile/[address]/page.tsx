import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAddress, isAddress } from "viem";
import { ProfileDashboard } from "@/components/profile-dashboard";
import { shortAddress } from "@/lib/utils";

type Props = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  return {
    title: isAddress(address) ? `${shortAddress(address, 6)} Profile` : "Profile",
    description: "View confirmed ArcOrigin positions, trades, activity, and launches for this wallet.",
  };
}

export default async function PublicProfilePage({ params }: Props) {
  const { address } = await params;
  if (!isAddress(address)) notFound();
  return <ProfileDashboard profileAddress={getAddress(address)} />;
}
