import Image from "next/image";
import Link from "next/link";
import { arcChain } from "@/lib/chains";

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
    <div className="overflow-hidden rounded-[22px] border border-line bg-panel shadow-glow">
      <div className="grid gap-10 px-6 py-8 md:grid-cols-[1.25fr_.7fr_.7fr_1.35fr] md:px-9 md:py-10">
        <div>
          <Link href="/" className="inline-flex items-center gap-3 text-white transition hover:opacity-85">
            <Image src="/brand/arcorigin-logo-v2.png" alt="" width={42} height={42} className="size-10 rounded-xl border border-cyan/20 bg-[var(--surface-2)] object-cover" />
            <span className="text-lg font-semibold tracking-[-.035em]">ArcOrigin</span>
          </Link>
          <p className="mt-4 max-w-[310px] text-[13px] leading-6 text-slate-400">
            Launch and explore fixed-supply tokens on {arcChain.name}. Every transaction is prepared by the interface and submitted through your wallet.
          </p>
        </div>
        <FooterColumn title="Product" links={productLinks} />
        <FooterColumn title="Legal" links={legalLinks} />
        <div>
          <p className="text-xs font-semibold text-slate-300">Risk notice</p>
          <p className="mt-3 text-[13px] leading-6 text-slate-400">
            Transactions may be irreversible. Tokens can be volatile and lose all value. ArcOrigin does not custody assets or provide financial advice.
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-3 border-t border-line px-6 py-5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between md:px-9">
        <p>© 2026 ArcOrigin.</p>
        <a
          href="https://x.com/arcorigin_"
          target="_blank"
          rel="noreferrer"
          aria-label="Follow ArcOrigin on X"
          className="group inline-flex h-9 w-fit items-center gap-2.5 rounded-[10px] border border-line bg-white/[.025] px-3 font-semibold text-slate-300 transition hover:border-cyan/30 hover:bg-cyan/[.05] hover:text-white"
        >
          <span className="grid size-5 place-items-center rounded-md bg-white/[.055] text-slate-200 transition group-hover:bg-cyan/10 group-hover:text-cyan">
            <svg viewBox="0 0 24 24" aria-hidden="true" className="size-3" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.657l-5.214-6.817-5.965 6.817H1.68l7.73-8.835L1.254 2.25h6.826l4.713 6.231 5.451-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
            </svg>
          </span>
          <span>@arcorigin_</span>
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
