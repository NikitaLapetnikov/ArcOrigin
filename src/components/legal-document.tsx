import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";

export type LegalSection = {
  title: string;
  content: ReactNode;
};

export function LegalDocument({
  label,
  title,
  summary,
  effectiveDate,
  sections,
}: {
  label: string;
  title: string;
  summary: string;
  effectiveDate: string;
  sections: LegalSection[];
}) {
  return <div className="container-shell py-10 md:py-14">
    <div className="mb-5">
      <Link href="/tokens" className="inline-flex items-center gap-2 text-sm font-medium text-slate-400 transition hover:text-white">
        <ArrowLeft className="size-4" />Back to markets
      </Link>
    </div>
    <div className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
      <aside className="h-fit rounded-2xl border border-line bg-panel p-4 lg:sticky lg:top-24">
        <p className="px-3 pb-3 text-[11px] font-semibold uppercase tracking-[.12em] text-cyan">{label}</p>
        <nav aria-label={`${title} sections`} className="grid gap-1">
          {sections.map((section, index) => <a key={section.title} href={`#section-${index + 1}`} className="rounded-lg px-3 py-2 text-[13px] text-slate-400 transition hover:bg-white/[.035] hover:text-white">
            {section.title}
          </a>)}
        </nav>
      </aside>
      <article className="overflow-hidden rounded-2xl border border-line bg-panel shadow-glow">
        <header className="border-b border-line px-6 py-8 sm:px-9 sm:py-10">
          <p className="eyebrow">{label}</p>
          <h1 className="mt-4 text-[38px] font-semibold tracking-[-.05em] text-white sm:text-[48px]">{title}</h1>
          <p className="mt-4 max-w-2xl text-[15px] leading-7 text-slate-400">{summary}</p>
          <p className="mt-5 text-xs text-slate-500">Effective {effectiveDate}</p>
        </header>
        <div className="px-6 sm:px-9">
          {sections.map((section, index) => <section id={`section-${index + 1}`} key={section.title} className="scroll-mt-28 border-b border-line py-8 last:border-0">
            <div className="grid gap-3 sm:grid-cols-[42px_minmax(0,1fr)]">
              <span className="font-mono text-[11px] text-slate-600">{String(index + 1).padStart(2, "0")}</span>
              <div className="legal-copy">
                <h2>{section.title}</h2>
                {section.content}
              </div>
            </div>
          </section>)}
        </div>
      </article>
    </div>
  </div>;
}
