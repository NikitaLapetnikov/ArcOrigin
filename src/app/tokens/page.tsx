import type { Metadata } from "next";
import { TokenScreener } from "@/components/token-screener";
import { PageIntro } from "@/components/ui";

export const metadata: Metadata = { title: "Token Screener" };
export default function TokensPage() { return <><PageIntro compact eyebrow="Markets" title="Explore tokens" body="Live markets on Arc."/><TokenScreener/></>; }
