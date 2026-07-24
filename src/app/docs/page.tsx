import type { Metadata } from "next";
import { PageIntro, Panel, WarningBox } from "@/components/ui";

export const metadata: Metadata = { title: "Documentation" };

const sections = [
  {
    title: "Launch",
    items: [
      ["Token", "Fixed supply, no owner mint, blacklist, pause, or transfer tax."],
      ["Allocation", "The creator allocation is visible and capped at 20%."],
      ["Cost", "Launching costs 25 USDC. An optional developer buy is a separate USDC payment and a real curve trade."],
    ],
  },
  {
    title: "Trade",
    items: [
      ["Curve", "A virtual-USDC-reserve constant-product curve prices each trade."],
      ["Liquidity", "Real USDC liquidity is shown separately from virtual quote depth, so sell-side backing is never overstated."],
      ["Protection", "Quotes include minimum output so slippage is enforced onchain."],
      ["Fees", "V4 buys and sells charge 1%: 70% is transferred to the token creator and 30% to the protocol FeeVault onchain."],
    ],
  },
  {
    title: "Graduate",
    items: [
      ["Target", "Current launches graduate after 80% of trading inventory is sold: 10,000 real USDC against a 2,500 virtual-USDC seed."],
      ["Continuity", "Virtual liquidity is removed while token reserves are rebalanced at the same spot price, avoiding a migration price jump."],
      ["Permanent AMM", "Price-matched tokens and real USDC stay in the curve as permanent two-sided liquidity; there is no owner withdrawal function."],
    ],
  },
  {
    title: "Verify",
    items: [
      ["Data", "Launches, trades, charts, and fees are read from Arc Testnet events."],
      ["Listings", "Only tokens confirmed by configured Arc Testnet Factory events are displayed."],
      ["Risk", "Visible labels organize observable signals; they never guarantee safety."],
    ],
  },
] as const;

export default function DocsPage() {
  return (
    <>
      <PageIntro
        eyebrow="Product guide"
        title="How ArcOrigin works"
        body="Launch, trade, graduation, and verification in one place."
      />
      <div className="container-shell grid gap-4 pb-20 lg:grid-cols-2">
        {sections.map((section, sectionIndex) => (
          <Panel key={section.title} className="p-5 md:p-6">
            <div className="flex items-center gap-3">
              <span className="grid size-8 place-items-center rounded-lg bg-cyan/10 font-mono text-[10px] text-cyan">
                0{sectionIndex + 1}
              </span>
              <h2 className="text-lg font-semibold text-white">{section.title}</h2>
            </div>
            <div className="mt-6 divide-y divide-line">
              {section.items.map(([label, body]) => (
                <div key={label} className="py-4 first:pt-0 last:pb-0">
                  <p className="text-sm font-medium text-white">{label}</p>
                  <p className="mt-1.5 text-sm leading-6 text-slate-500">{body}</p>
                </div>
              ))}
            </div>
          </Panel>
        ))}
        <div className="lg:col-span-2">
          <WarningBox>
            ArcOrigin is live on testnet, has not completed a mainnet audit, and is not financial advice. Legacy curves retain their original immutable fee and graduation behavior; V4 curves use the 70/30 creator fee split and permanent-liquidity model.
          </WarningBox>
        </div>
      </div>
    </>
  );
}
