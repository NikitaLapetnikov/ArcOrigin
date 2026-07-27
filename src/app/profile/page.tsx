import type { Metadata } from "next";
import { ProfileDashboard } from "@/components/profile-dashboard";

export const metadata: Metadata = {
  title: "Profile",
  description: "View confirmed ArcOrigin positions, trades, activity, and token launches for your connected wallet.",
};

export default function ProfilePage() {
  return <ProfileDashboard />;
}
