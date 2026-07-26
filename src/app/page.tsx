import { TokenScreener } from "@/components/token-screener";
import { PageIntro } from "@/components/ui";

export default function Home() {
  return <>
    <PageIntro compact eyebrow="Markets" title="Explore tokens" />
    <TokenScreener />
  </>;
}
