import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import {
  ARCORIGIN_CROSS_MARKET_CAP_USDC,
  ARCORIGIN_START_MARKET_CAP_USDC,
  ARC_ACTIVE_CONTRACTS,
  ARC_ACTIVE_FACTORY_BLOCK,
  ARC_OFFICIAL_ORIGIN_TOKEN,
  ARC_UNISWAP_V3,
  EXPLORER_URL,
  arcChain,
} from "@/lib/chains";

export const metadata: Metadata = {
  title: "Documentation",
  description: "ArcOrigin direct Uniswap V3 launch and integration reference.",
};

const contracts = [
  ["Factory", ARC_ACTIVE_CONTRACTS.factory, `From block ${ARC_ACTIVE_FACTORY_BLOCK.toLocaleString()}`],
  ["Fee Vault", ARC_ACTIVE_CONTRACTS.feeVault, "Protocol fee accounting"],
  ["Creator Registry", ARC_ACTIVE_CONTRACTS.creatorRegistry, "Creator launch records"],
  ["USDC", ARC_ACTIVE_CONTRACTS.usdc, "Quote and settlement asset"],
  ["Uniswap V3 Factory", ARC_UNISWAP_V3.factory, "Canonical pool registry"],
  ["Uniswap V3 Router", ARC_UNISWAP_V3.router, "Buy and sell execution"],
] as const;

const sections = ["overview", "launch", "trading", "fees", "events", "contracts", "integrations", "risks"] as const;

export default function DocsPage() {
  return <div className="relative overflow-hidden pb-24">
    <section className="container-shell pt-10 md:pt-14">
      <div className="grid items-end gap-9 border-b border-line pb-10 lg:grid-cols-[minmax(0,1fr)_540px]">
        <div>
          <h1 className="text-[38px] font-semibold tracking-[-.05em] text-white sm:text-[52px]">ArcOrigin documentation</h1>
          <p className="mt-5 max-w-xl text-[15px] leading-7 text-slate-400">One launch architecture: a fixed-supply token, a canonical USDC Uniswap V3 pool, and permanently locked liquidity from the launch transaction.</p>
          <p className="mt-5 text-xs text-slate-500">{arcChain.name} · Chain ID {arcChain.id}</p>
        </div>
        <div className="grid overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2">
          <Fact label="Launch fee" value="1 USDC" />
          <Fact label="Initial market cap" value={`${ARCORIGIN_START_MARKET_CAP_USDC.toLocaleString()} USDC`} />
          <Fact label="Trading fee" value="1%" />
          <Fact label="Crossed mark" value={`${ARCORIGIN_CROSS_MARKET_CAP_USDC.toLocaleString()} USDC`} />
        </div>
      </div>
    </section>

    <div className="container-shell mt-8 grid items-start gap-5 lg:grid-cols-[230px_minmax(0,1fr)]">
      <aside className="rounded-2xl border border-line bg-panel p-3 lg:sticky lg:top-[92px]">
        <nav className="grid gap-1">{sections.map((section) => <a key={section} href={`#${section}`} className="rounded-lg px-3 py-2 text-sm capitalize text-slate-400 hover:bg-white/[.04] hover:text-white">{section}</a>)}</nav>
      </aside>
      <main className="overflow-hidden rounded-2xl border border-line bg-panel">
        <Section id="overview" title="Overview">
          <p>ArcOrigin is non-custodial. Every launch creates a one-billion-token fixed supply and immediately initializes its canonical token/USDC pool at a 5,000 USDC market cap. The LP NFT is sent to an immutable locker and cannot be withdrawn.</p>
          <p>There is no separate pricing contract and no migration lifecycle. The 50,000 USDC mark changes only the token status to Crossed; trading and liquidity stay in the same pool.</p>
          <p>The Official ORIGIN label is address-bound to <code className="break-all text-xs text-cyan">{ARC_OFFICIAL_ORIGIN_TOKEN ?? "the canonical mainnet ORIGIN contract"}</code>; a copied name, symbol, or image cannot receive it. The Auto Buyback label is shown only when the immutable <code className="text-xs text-cyan">automaticBuyback</code> flag in the Factory token record is enabled.</p>
        </Section>
        <Section id="launch" title="Create a token">
          <ol className="grid gap-3">
            <li>1. Add the token identity, public metadata, image, and optional links.</li>
            <li>2. Sign the metadata commitment and publish it to IPFS.</li>
            <li>3. Approve the launch fee and call the Factory.</li>
            <li>4. The Factory creates the token, pool, liquidity position, and permanent lock atomically.</li>
            <li>5. Optionally complete a separate creator buy of up to 100 USDC through the canonical Uniswap V3 Router. The app requests a fresh quote and enforces 10% minimum-output protection.</li>
            <li>6. Optionally enable automatic buyback and burn. This choice permanently redirects the creator fee share and cannot be changed later.</li>
          </ol>
          <Callout>Creators receive no free token allocation. The optional initial creator buy is a transparent normal pool trade after launch. Rejecting or failing it does not reverse a confirmed token launch.</Callout>
        </Section>
        <Section id="trading" title="Trading">
          <p>Buys and sells use the canonical Uniswap V3 Router. Quotes come from the official Quoter and are accepted only after the app verifies the pool against both the ArcOrigin Factory and the Uniswap Factory.</p>
          <p>Slippage protection is enforced with a minimum output. Token addresses are the identity of a market; names and symbols are not unique.</p>
        </Section>
        <Section id="fees" title="Fees">
          <p>The pool uses the 1% Uniswap fee tier. Ordinary launches split collected LP fees 70% to the creator and 30% to the protocol Fee Vault. Anyone may trigger fee collection, but cannot redirect or withdraw the LP position.</p>
          <p>If automatic buyback is enabled at launch, the creator permanently redirects that 70% share: token fees burn immediately and USDC fees buy and burn the token in protected batches. The protocol share remains 30%. Execution requires at least 1 USDC, a 15-minute cooldown, and a safe 15-minute TWAP; the caller earns 0.5% of USDC spent, capped at 1 USDC.</p>
          <p>Each enabled token page exposes an onchain transparency panel with the pending USDC reserve, cumulative USDC spent, tokens bought and burned, execution count, latest transaction, and platform keeper funding status. The values are derived from the locker state and <code className="text-xs text-cyan">BuybackExecuted</code> events.</p>
        </Section>
        <Section id="events" title="Onchain events">
          <Definition rows={[
            ["TokenLaunched", "Token, pool, creator, name, symbol, and position ID."],
            ["TokenCrossed", "Permanent record that live market cap reached the configured mark."],
            ["AutomaticBuybackConfigured", "Immutable per-position buyback choice recorded at launch."],
            ["Swap", "Canonical price, volume, and trade history from the Uniswap pool."],
            ["Transfer", "Canonical holder balances and token movements."],
            ["FeesClaimed", "Creator/buyback and protocol portions routed by the locker."],
            ["BuybackExecuted", "USDC spent, keeper reward, tokens burned, and reserve remaining."],
          ]} />
        </Section>
        <Section id="contracts" title="Contracts">
          <div className="divide-y divide-line">{contracts.map(([label, address, detail]) => <div key={label} className="grid gap-2 py-4 sm:grid-cols-[180px_minmax(0,1fr)_auto] sm:items-center"><span className="text-slate-300">{label}</span><code className="break-all text-xs text-slate-500">{address}</code><a href={`${EXPLORER_URL}/address/${address}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-cyan">Explorer <ExternalLink className="size-3" /></a><span className="text-xs text-slate-600 sm:col-start-2">{detail}</span></div>)}</div>
        </Section>
        <Section id="integrations" title="Indexer integration">
          <p>Screeners and analytics services can discover ArcOrigin launches from the Factory and enrich them with the public token list. The endpoint includes token and pool addresses, creator, image, website, X, Telegram, immutable auto-buyback status, and the address-bound Official ORIGIN marker.</p>
          <Definition rows={[
            ["Token list", "https://arcorigin.xyz/api/tokenlist"],
            ["Factory", ARC_ACTIVE_CONTRACTS.factory],
            ["From block", ARC_ACTIVE_FACTORY_BLOCK.toString()],
            ["Event", "TokenLaunched(address,address,address,string,string,uint256)"],
            ["Platform logo", "https://arcorigin.xyz/brand/arcorigin-logo-v2.png"],
          ]} />
          <Callout>The endpoint is public, requires no API key, permits cross-origin reads, and keeps metadata compatible with external DEX screeners.</Callout>
        </Section>
        <Section id="risks" title="Risks">
          <p>Tokens can be volatile and lose all value. Permanent liquidity prevents LP withdrawal but does not guarantee demand, price stability, token quality, or sufficient depth for a large trade. Smart contracts, wallets, RPC providers, Uniswap, and metadata gateways can fail.</p>
          <Callout>Verify contract and pool addresses in the explorer before signing. ArcOrigin does not custody assets or provide financial advice.</Callout>
        </Section>
      </main>
    </div>
  </div>;
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return <section id={id} className="scroll-mt-24 border-b border-line p-6 last:border-0 md:p-9"><h2 className="text-2xl font-semibold text-white">{title}</h2><div className="mt-5 grid gap-4 text-sm leading-7 text-slate-400">{children}</div></section>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="bg-panel p-5"><p className="text-xs text-slate-500">{label}</p><p className="mt-2 font-semibold text-white">{value}</p></div>;
}

function Callout({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-cyan/15 bg-cyan/[.04] p-4 text-slate-300">{children}</div>;
}

function Definition({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return <dl className="divide-y divide-line">{rows.map(([term, detail]) => <div key={term} className="grid gap-1 py-3 sm:grid-cols-[160px_1fr]"><dt className="font-medium text-slate-200">{term}</dt><dd>{detail}</dd></div>)}</dl>;
}
