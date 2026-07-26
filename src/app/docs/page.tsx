import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import {
  ARC_TESTNET_CONTRACTS,
  ARC_TESTNET_V4_FACTORY_BLOCK,
  EXPLORER_URL,
  arcTestnet,
} from "@/lib/chains";

export const metadata: Metadata = {
  title: "Documentation",
  description: "ArcOrigin protocol, trading, graduation, contracts, and integration reference.",
};

const navigation = [
  {
    label: "Protocol",
    items: [
      ["Overview", "overview"],
      ["Create a token", "launch"],
      ["Trading", "trading"],
      ["Bonding curve", "curve"],
      ["Graduation", "graduation"],
      ["Fees", "fees"],
    ],
  },
  {
    label: "Integration",
    items: [
      ["Network", "network"],
      ["Contracts", "contracts"],
      ["Onchain events", "events"],
      ["Reading state", "reading"],
    ],
  },
  {
    label: "Reference",
    items: [
      ["Protocol limits", "limits"],
      ["Risks", "risks"],
      ["Security review", "security"],
      ["FAQ", "faq"],
    ],
  },
] as const;

const contracts = [
  ["V4 Factory", ARC_TESTNET_CONTRACTS.factory, `From block ${ARC_TESTNET_V4_FACTORY_BLOCK.toLocaleString()}`],
  ["Fee Vault", ARC_TESTNET_CONTRACTS.feeVault, "Protocol fee accounting"],
  ["Creator Registry", ARC_TESTNET_CONTRACTS.creatorRegistry, "Factory launch records"],
  ["USDC", ARC_TESTNET_CONTRACTS.usdc, "Quote and settlement asset"],
] as const;

const events = [
  ["TokenLaunched", "Factory", "Token, curve, creator, name, and symbol."],
  ["TokenBought", "Curve", "Buyer, USDC input, token output, and fee."],
  ["TokenSold", "Curve", "Seller, token input, USDC output, and fee."],
  ["FeeSplit", "Curve", "Creator and protocol portions of each trading fee."],
  ["CurveGraduated", "Curve", "Real USDC raised and tokens sold at graduation."],
  ["Transfer", "Token", "Canonical source for balances and holder distribution."],
] as const;

export default function DocsPage() {
  return <div className="relative overflow-hidden pb-24">
    <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] grid-line opacity-20 [mask-image:linear-gradient(to_bottom,black,transparent)]" />

    <section className="container-shell relative pt-10 md:pt-14">
      <div className="overflow-hidden rounded-3xl border border-line bg-panel">
        <div className="relative px-6 py-12 sm:px-10 md:py-16 lg:px-14">
          <div className="pointer-events-none absolute right-0 top-0 size-72 rounded-full bg-cyan/[.07] blur-[110px]" />
          <p className="eyebrow">ArcOrigin docs</p>
          <h1 className="relative mt-5 max-w-4xl text-[42px] font-semibold leading-[.98] tracking-[-.06em] text-white sm:text-[56px] md:text-[68px]">
            Launch and trade<br className="hidden sm:block" /> with visible rules.
          </h1>
          <p className="relative mt-6 max-w-2xl text-base leading-7 text-slate-400">
            Protocol mechanics, integration details, and honest testnet limitations in one place.
          </p>
          <div className="relative mt-8 flex flex-wrap gap-2">
            <DocPill label="Arc Testnet" />
            <DocPill label="USDC markets" />
            <DocPill label="V4 active" tone="cyan" />
            <DocPill label="Unaudited testnet" tone="warn" />
          </div>
        </div>
        <div className="grid border-t border-line sm:grid-cols-2 lg:grid-cols-4">
          <HeroFact label="Current launch fee" value="25 USDC" />
          <HeroFact label="Trading fee" value="1%" />
          <HeroFact label="Fee split" value="70 / 30" />
          <HeroFact label="Graduation" value="10,000 USDC" />
        </div>
      </div>
    </section>

    <div className="container-shell relative mt-5 grid items-start gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
      <aside className="overflow-hidden rounded-2xl border border-line bg-panel lg:sticky lg:top-[92px]">
        <div className="border-b border-line px-5 py-4">
          <p className="font-mono text-[10px] uppercase tracking-[.14em] text-slate-500">Documentation</p>
        </div>
        <nav aria-label="Documentation sections" className="flex gap-2 overflow-x-auto p-2 lg:grid lg:gap-4">
          {navigation.map((group) => <div key={group.label} className="flex shrink-0 gap-1 lg:grid">
            <p className="hidden px-3 pt-1 font-mono text-[9px] uppercase tracking-[.14em] text-slate-600 lg:block">{group.label}</p>
            {group.items.map(([label, id]) => <a
              key={id}
              href={`#${id}`}
              className="flex h-9 shrink-0 items-center rounded-lg px-3 text-sm font-medium text-slate-400 transition hover:bg-white/[.04] hover:text-white"
            >
              {label}
            </a>)}
          </div>)}
        </nav>
        <div className="m-3 rounded-xl border border-line bg-black/20 p-3">
          <p className="text-xs font-medium text-white">Arc Testnet</p>
          <p className="mt-1 font-mono text-[10px] text-slate-500">Chain ID {arcTestnet.id}</p>
        </div>
      </aside>

      <main className="min-w-0 overflow-hidden rounded-2xl border border-line bg-panel">
        <DocSection id="overview" eyebrow="Protocol" title="Overview">
          <p>ArcOrigin is a non-custodial token launchpad and trading terminal on Arc Testnet. Every launch creates a fixed-supply ERC-20 token and its own USDC bonding curve. Wallets interact directly with the deployed contracts.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <MiniCard title="Custody" value="Your wallet" body="ArcOrigin does not hold user wallets or trade balances." />
            <MiniCard title="Settlement" value="USDC" body="Launches, trades, fees, and curve reserves settle on Arc Testnet." />
          </div>
          <Callout title="Key facts">
            <ul className="grid gap-2.5">
              <li>Token names and symbols are not unique. Verify the contract address.</li>
              <li>Quotes, reserves, fees, and graduation progress are denominated in USDC.</li>
              <li>Charts and holder data are reconstructed from confirmed onchain events.</li>
            </ul>
          </Callout>
          <Callout title="V4 scope" tone="neutral">
            ArcOrigin V4 has market buys and sells on a dedicated curve. It does not currently provide limit orders, external DEX migration, liquidity-provider positions, chat, or community takeovers.
          </Callout>
        </DocSection>

        <DocSection id="launch" eyebrow="Create" title="Create a token">
          <p>The current interface launches a one-billion-token fixed supply with zero free creator allocation. The creator may add an optional paid developer buy, executed as a normal curve purchase after launch.</p>
          <StepList items={[
            ["Profile", "Set the name, ticker, description, image, website, and X profile."],
            ["Metadata", "The image and metadata are committed, signed by the wallet, and stored on IPFS."],
            ["Deploy", "Approve the 25 USDC launch fee, then deploy the token and curve through the V4 Factory."],
            ["Optional buy", "Approve the chosen USDC amount and buy from the same curve as every other trader."],
          ]} />
          <SpecGrid items={[
            ["Supply", "1,000,000,000"],
            ["Free creator allocation", "0%"],
            ["Current launch fee", "25 USDC"],
            ["Developer buy", "Optional · max 5% through the app"],
          ]} />
          <Callout title="Metadata is public" tone="neutral">
            The token stores an immutable IPFS metadata URI. Images, descriptions, and social links are public. Do not upload private or sensitive information.
          </Callout>
        </DocSection>

        <DocSection id="trading" eyebrow="Execution" title="Trading">
          <p>Each token trades only against USDC in its dedicated curve. Buy and sell quotes are read from the contract before the wallet transaction is submitted.</p>
          <DefinitionList items={[
            ["You receive", "The current contract quote after the 1% trading fee."],
            ["Minimum received", "The lowest output accepted onchain after applying your slippage setting."],
            ["Slippage", "Execution tolerance. ArcOrigin provides 10%, 20%, 40%, and manual input."],
            ["Priority", "A wallet fee preference. It affects inclusion speed, not the curve price."],
            ["Approval", "USDC is approved before a buy; the launch token is approved before a sell."],
          ]} />
          <Callout title="A quote is not a reservation" tone="neutral">
            Another confirmed trade can move the curve before yours executes. The minimum-received value is the onchain protection against a worse fill.
          </Callout>
        </DocSection>

        <DocSection id="curve" eyebrow="Pricing" title="Bonding curve">
          <p>Before graduation, pricing follows a constant-product curve using the real token reserve and an effective USDC reserve. The effective reserve is the 2,500 virtual-USDC seed plus USDC deposited by buyers.</p>
          <CodeBlock>{`effective USDC = virtual USDC + real USDC
spot price     = effective USDC / token reserve
x · y          = constant before each trade`}</CodeBlock>
          <div className="grid gap-3 sm:grid-cols-2">
            <MiniCard title="Virtual reserve" value="2,500 USDC" body="Shapes the starting price. It is not real or withdrawable liquidity." />
            <MiniCard title="Real liquidity" value="Onchain USDC" body="Backs sells and is displayed separately from virtual quote depth." />
          </div>
          <p>Buy outputs round conservatively in favor of the reserve. Sell outputs cannot exceed real USDC liquidity. The contract returns a zero quote when a trade cannot be executed safely.</p>
        </DocSection>

        <DocSection id="graduation" eyebrow="Lifecycle" title="Graduation">
          <p>Graduation occurs when the curve reaches 10,000 real USDC. There is no external DEX migration. Trading continues in the same curve contract.</p>
          <StepList items={[
            ["Threshold", "The final pre-graduation buy is capped so net real reserves cannot exceed 10,000 USDC."],
            ["Rebalance", "Virtual USDC is removed and the remaining token reserve is resized at the same spot price."],
            ["Lock", "Surplus curve inventory is sent irreversibly to the dead address."],
            ["Continue", "Real USDC and price-matched tokens remain in the curve as two-sided liquidity."],
          ]} />
          <Callout title="What graduation does not mean" tone="neutral">
            Graduation is a mechanical liquidity milestone—not an endorsement, safety rating, or guarantee of future volume.
          </Callout>
        </DocSection>

        <DocSection id="fees" eyebrow="Economics" title="Fees">
          <p>V4 fee distribution is enforced by the deployed contracts, not estimated by the interface.</p>
          <div className="grid gap-3 md:grid-cols-3">
            <MiniCard title="Buy / sell" value="1%" body="Charged on every completed curve trade." />
            <MiniCard title="Creator" value="70%" body="Sent directly to the token creator from each trading fee." />
            <MiniCard title="Protocol" value="30%" body="Recorded and held by the ArcOrigin Fee Vault." />
          </div>
          <p className="text-sm text-slate-500">The creator share is sent directly during each trade; there is no separate claim action. The protocol share and launch fee enter the Fee Vault. An optional developer buy pays the standard trading fee.</p>
          <Callout title="Configuration" tone="neutral">
            The Factory owner can change the launch fee and the fee rates for future curves. Each deployed curve permanently snapshots its own buy and sell fee rates.
          </Callout>
        </DocSection>

        <DocSection id="network" eyebrow="Integration" title="Network">
          <DefinitionList items={[
            ["Network", "Arc Testnet"],
            ["Chain ID", String(arcTestnet.id)],
            ["Quote asset", "USDC"],
            ["Public RPC", arcTestnet.rpcUrls.default.http[0]],
            ["Explorer", EXPLORER_URL],
            ["V4 start block", ARC_TESTNET_V4_FACTORY_BLOCK.toLocaleString()],
          ]} mono />
        </DocSection>

        <DocSection id="contracts" eyebrow="Integration" title="Contracts">
          <p>These are the active ArcOrigin V4 addresses used by the interface. Always verify addresses before building an integration.</p>
          <div className="overflow-hidden rounded-xl border border-line">
            {contracts.map(([label, address, detail]) => <a
              key={label}
              href={`${EXPLORER_URL}/address/${address}`}
              target="_blank"
              rel="noreferrer"
              className="group grid gap-2 border-b border-line px-4 py-4 transition last:border-0 hover:bg-white/[.025] md:grid-cols-[170px_minmax(0,1fr)_170px] md:items-center"
            >
              <span className="text-sm font-medium text-white">{label}</span>
              <code className="break-all text-xs text-cyan">{address}</code>
              <span className="flex items-center gap-2 text-xs text-slate-500 md:justify-end">{detail}<ExternalLink className="size-3.5 group-hover:text-cyan" /></span>
            </a>)}
          </div>
        </DocSection>

        <DocSection id="events" eyebrow="Integration" title="Onchain events">
          <p>Index bounded block ranges from the V4 start block. Events are the authoritative source for launches, trades, fees, charts, and holders.</p>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead><tr className="border-b border-line bg-black/20 text-xs text-slate-500"><th className="px-4 py-3 font-medium">Event</th><th className="font-medium">Contract</th><th className="pr-4 font-medium">Use</th></tr></thead>
              <tbody>{events.map(([event, source, use]) => <tr key={event} className="border-b border-line/70 last:border-0"><td className="px-4 py-3.5"><code className="text-cyan">{event}</code></td><td className="text-slate-300">{source}</td><td className="pr-4 text-slate-500">{use}</td></tr>)}</tbody>
            </table>
          </div>
        </DocSection>

        <DocSection id="reading" eyebrow="Integration" title="Reading token state">
          <p>Use contract reads for current state and confirmed events for history. Never derive an executable quote from chart candles or cached market cards.</p>
          <DefinitionList items={[
            ["Discovery", "Read TokenLaunched from the V4 Factory beginning at the published start block."],
            ["Token ↔ curve", "Read getTokenInfo(token) on the Factory."],
            ["Buy quote", "Call quoteBuy(usdcAmount) on the token curve."],
            ["Sell quote", "Call quoteSell(tokenAmount) on the token curve."],
            ["Liquidity", "Read realLiquidity(); do not include virtual USDC."],
            ["Graduation", "Read isGraduated() and getCurveProgress()."],
            ["Holders", "Replay ERC-20 Transfer events and reconcile balances."],
          ]} mono />
          <CodeBlock>{`const [tokensOut, fee] = await publicClient.readContract({
  address: curve,
  abi: bondingCurveAbi,
  functionName: "quoteBuy",
  args: [parseUnits("100", 6)],
});`}</CodeBlock>
          <Callout title="Indexing rule" tone="neutral">
            Treat a transaction as final UI state only after its receipt succeeds. Apply receipt events immediately, then reconcile against current contract reads. RPC failures should preserve the last confirmed snapshot, never invent replacement data.
          </Callout>
        </DocSection>

        <DocSection id="limits" eyebrow="Reference" title="Protocol limits">
          <p>The website uses a narrower, canonical launch profile than the Factory contract permits. This distinction matters for third-party integrations.</p>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead><tr className="border-b border-line bg-black/20 text-xs text-slate-500"><th className="px-4 py-3 font-medium">Parameter</th><th className="font-medium">ArcOrigin app</th><th className="pr-4 font-medium">V4 Factory limit</th></tr></thead>
              <tbody>
                {[
                  ["Name", "Required", "1–64 UTF-8 bytes"],
                  ["Symbol", "Required · max 10 bytes", "1–10 UTF-8 bytes"],
                  ["Supply", "1 billion", "Any non-zero value"],
                  ["Free creator allocation", "0%", "Up to 20%"],
                  ["Developer buy", "Paid · up to 5%", "A separate curve trade"],
                  ["Metadata URI", "IPFS", "Up to 512 UTF-8 bytes"],
                  ["Graduation ratio", "10,000 / 2,500", "Threshold must equal 4× virtual reserve"],
                ].map(([parameter, app, factory]) => <tr key={parameter} className="border-b border-line/70 last:border-0"><td className="px-4 py-3.5 font-medium text-white">{parameter}</td><td className="text-slate-400">{app}</td><td className="pr-4 text-slate-500">{factory}</td></tr>)}
              </tbody>
            </table>
          </div>
          <Callout title="Verify direct launches" tone="warn">
            A token created by calling the Factory outside the ArcOrigin interface can use non-canonical supply or creator allocation. Read the deployed token and curve state instead of assuming website defaults.
          </Callout>
        </DocSection>

        <DocSection id="risks" eyebrow="Read before trading" title="Risks">
          <p>ArcOrigin is live on testnet and has not completed an independent mainnet audit. User-created tokens can be volatile, illiquid, duplicated, or lose all value.</p>
          <Callout title="Before signing" tone="warn">
            <ul className="grid gap-2.5">
              <li>Verify the token and curve contract addresses.</li>
              <li>Review the quote, minimum received, liquidity, and holder concentration.</li>
              <li>Remember that wallets, RPC providers, indexers, and smart contracts can fail.</li>
              <li>ArcOrigin is not financial advice and does not guarantee token quality.</li>
            </ul>
          </Callout>
        </DocSection>

        <DocSection id="security" eyebrow="Engineering review" title="Security review">
          <p>An internal security and logic review was completed on 26 July 2026 across the V4 contracts, wallet flows, metadata upload, indexing, caching, and production headers. It is not an independent audit or mainnet approval.</p>
          <Callout title="Review outcome" tone="neutral">
            <ul className="grid gap-2.5">
              <li>No direct unauthorized-withdrawal or curve reserve-drain path was found in the reviewed flows.</li>
              <li>Trade updates now use confirmed receipt events and current contract reserves.</li>
              <li>Quote, upload, refresh, holder, and fee-indexing trust boundaries were hardened.</li>
              <li>Production dependencies have no known high-severity advisories; remaining advisories are confined to development tooling.</li>
            </ul>
          </Callout>
          <Callout title="Still required before mainnet" tone="warn">
            Independent audit, verified reproducible deployments, multisig and timelock administration, a hardened V5 fee/configuration design, durable reorg-aware indexing, monitoring, and edge rate limiting.
          </Callout>
          <a
            href="https://github.com/VadymManiuk/ArcForge/blob/main/SECURITY.md"
            target="_blank"
            rel="noreferrer"
            className="inline-flex w-fit items-center gap-2 text-sm font-medium text-cyan hover:underline"
          >
            Read the full findings and residual-risk register <ExternalLink className="size-4" />
          </a>
        </DocSection>

        <DocSection id="faq" eyebrow="Reference" title="FAQ" last>
          <FaqItem question="Where does a token migrate after graduation?">
            Nowhere. V4 removes the virtual reserve, locks surplus token inventory at the dead address, and continues trading inside the same curve contract.
          </FaqItem>
          <FaqItem question="Who receives the 25 USDC launch fee?">
            The Fee Vault receives it. The configured vault recipient can withdraw protocol funds; token creators cannot withdraw the launch fee.
          </FaqItem>
          <FaqItem question="Can the creator mint more tokens or blacklist wallets?">
            No. The ArcOrigin token has fixed supply and no mint, blacklist, pause, or transfer-tax controls.
          </FaqItem>
          <FaqItem question="Why can the displayed chart differ from a fresh quote?">
            Candles summarize confirmed historical trades. A quote reads the current curve state and can change with every newly confirmed trade.
          </FaqItem>
          <FaqItem question="Is ArcOrigin audited?">
            An internal engineering review is published, but V4 has not completed an independent smart-contract audit and should be treated as testnet software.
          </FaqItem>
        </DocSection>
      </main>
    </div>
  </div>;
}

function DocSection({ id, eyebrow, title, children, last = false }: {
  id: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return <section id={id} className={`scroll-mt-28 px-5 py-10 sm:px-8 md:py-12 lg:px-10 ${last ? "" : "border-b border-line"}`}>
    <p className="font-mono text-[10px] uppercase tracking-[.14em] text-cyan">{eyebrow}</p>
    <h2 className="mt-3 text-3xl font-semibold tracking-[-.04em] text-white md:text-[38px]">{title}</h2>
    <div className="mt-5 grid gap-6 text-[15px] leading-7 text-slate-400">{children}</div>
  </section>;
}

function HeroFact({ label, value }: { label: string; value: string }) {
  return <div className="border-b border-line px-6 py-5 last:border-b-0 sm:border-r sm:[&:nth-child(n+3)]:border-b-0 lg:border-b-0">
    <p className="font-mono text-[9px] uppercase tracking-[.12em] text-slate-600">{label}</p>
    <p className="mt-2 text-lg font-semibold text-white">{value}</p>
  </div>;
}

function DocPill({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "cyan" | "warn" }) {
  const style = tone === "cyan"
    ? "border-cyan/20 bg-cyan/[.07] text-cyan"
    : tone === "warn"
      ? "border-amber-300/20 bg-amber-300/[.06] text-amber-200"
      : "border-line bg-black/20 text-slate-300";
  return <span className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${style}`}>{label}</span>;
}

function Callout({ title, children, tone = "cyan" }: { title: string; children: React.ReactNode; tone?: "cyan" | "neutral" | "warn" }) {
  const style = tone === "warn"
    ? "border-amber-300/20 bg-amber-300/[.05]"
    : tone === "neutral"
      ? "border-line bg-black/20"
      : "border-cyan/20 bg-cyan/[.045]";
  return <div className={`rounded-2xl border p-5 ${style}`}>
    <p className="mb-3 text-sm font-semibold text-white">{title}</p>
    <div className="text-sm leading-6 text-slate-400">{children}</div>
  </div>;
}

function StepList({ items }: { items: ReadonlyArray<readonly [string, string]> }) {
  return <ol className="divide-y divide-line border-y border-line">
    {items.map(([title, body], index) => <li key={title} className="grid gap-2 py-4 sm:grid-cols-[42px_150px_minmax(0,1fr)]">
      <span className="font-mono text-[10px] text-slate-600">{String(index + 1).padStart(2, "0")}</span>
      <span className="text-sm font-medium text-white">{title}</span>
      <span className="text-sm leading-6 text-slate-500">{body}</span>
    </li>)}
  </ol>;
}

function SpecGrid({ items }: { items: ReadonlyArray<readonly [string, string]> }) {
  return <dl className="grid gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2">
    {items.map(([label, value]) => <div key={label} className="bg-[#090e17] p-4">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-2 text-base font-semibold text-white">{value}</dd>
    </div>)}
  </dl>;
}

function MiniCard({ title, value, body }: { title: string; value: string; body: string }) {
  return <div className="rounded-2xl border border-line bg-black/15 p-5">
    <p className="text-xs font-medium uppercase tracking-[.08em] text-slate-500">{title}</p>
    <p className="mt-3 text-xl font-semibold tracking-[-.02em] text-white">{value}</p>
    <p className="mt-2 text-sm leading-6 text-slate-500">{body}</p>
  </div>;
}

function DefinitionList({ items, mono = false }: { items: ReadonlyArray<readonly [string, string]>; mono?: boolean }) {
  return <dl className="divide-y divide-line border-y border-line">
    {items.map(([term, description]) => <div key={term} className="grid gap-2 py-4 sm:grid-cols-[180px_minmax(0,1fr)]">
      <dt className="text-sm font-medium text-white">{term}</dt>
      <dd className={`break-all text-sm leading-6 text-slate-500 ${mono ? "font-mono text-xs" : ""}`}>{description}</dd>
    </div>)}
  </dl>;
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return <pre className="overflow-x-auto rounded-xl border border-line bg-[#070b12] px-5 py-4 font-mono text-sm text-cyan"><code>{children}</code></pre>;
}

function FaqItem({ question, children }: { question: string; children: React.ReactNode }) {
  return <div className="grid gap-2 border-b border-line pb-6 last:border-0 last:pb-0 md:grid-cols-[250px_minmax(0,1fr)]">
    <h3 className="text-sm font-semibold leading-6 text-white">{question}</h3>
    <p className="text-sm leading-6 text-slate-500">{children}</p>
  </div>;
}
