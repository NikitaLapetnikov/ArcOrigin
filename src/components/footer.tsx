import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

const productLinks = [
  ["Explore", "/tokens"],
  ["Create", "/launch"],
  ["Profile", "/profile"],
  ["Docs", "/docs"],
] as const;

const legalLinks = [
  ["Privacy Policy", "/privacy"],
  ["Terms of Use", "/terms"],
] as const;

export function Footer() {
  return <footer className="container-shell pb-5 pt-10 md:pb-8 md:pt-16">
    <div className="overflow-hidden rounded-[22px] border border-line bg-[#0a0f1a]/95 shadow-[0_24px_80px_rgba(0,0,0,.28)]">
      <div className="grid gap-10 px-6 py-8 md:grid-cols-[1.25fr_.7fr_.7fr_1.35fr] md:px-9 md:py-10">
        <div>
          <Link href="/" className="inline-flex items-center gap-3 text-white transition hover:opacity-85">
            <Image src="/brand/arcorigin-logo.png" alt="" width={42} height={42} className="size-10 rounded-xl border border-cyan/20 bg-[#030713] object-contain p-[3px]" />
            <span className="text-lg font-semibold tracking-[-.035em]">ArcOrigin</span>
          </Link>
          <p className="mt-4 max-w-[310px] text-[13px] leading-6 text-slate-400">
            Launch and explore fixed-supply tokens on Arc Testnet. Every transaction is prepared by the interface and submitted through your wallet.
          </p>
        </div>
        <FooterColumn title="Product" links={productLinks} />
        <FooterColumn title="Legal" links={legalLinks} />
        <div>
          <p className="text-xs font-semibold text-slate-300">Risk notice</p>
          <p className="mt-3 text-[13px] leading-6 text-slate-400">
            Transactions may be irreversible. Testnet tokens can be volatile and have no guaranteed value. ArcOrigin does not custody assets or provide financial advice.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-3 border-t border-line px-6 py-5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between md:px-9">
        <p>© 2026 ArcOrigin.</p>
        <a href="https://x.com/arcorigin_" target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1.5 font-medium text-slate-300 transition hover:text-white">
          @arcorigin_ <ArrowUpRight className="size-3.5" />
        </a>
      </div>
    </div>
  </footer>;
}

function FooterColumn({ title, links }: { title: string; links: ReadonlyArray<readonly [string, string]> }) {
  return <div>
    <p className="text-xs font-semibold text-slate-300">{title}</p>
    <nav className="mt-3 grid gap-2.5" aria-label={`${title} footer links`}>
      {links.map(([label, href]) => <Link key={href} href={href} className="w-fit text-[13px] text-slate-400 transition hover:text-white">{label}</Link>)}
    </nav>
  </div>;
}
