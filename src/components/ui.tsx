import Link from "next/link";
import type { HTMLAttributes, ReactNode } from "react";
import { ExternalLink, TriangleAlert } from "lucide-react";
import { EXPLORER_URL } from "@/lib/chains";
import { cn, shortAddress } from "@/lib/utils";

export function Button({ className, variant = "primary", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return <button className={cn("inline-flex h-10 items-center justify-center gap-2 rounded-[10px] px-4 text-[13px] font-semibold transition duration-150 disabled:cursor-not-allowed disabled:opacity-40", variant === "primary" && "bg-cyan text-[#041018] shadow-[0_8px_24px_rgba(57,189,248,.16)] hover:bg-[#61cbf8] active:translate-y-px", variant === "secondary" && "border border-line bg-white/[.035] text-slate-100 hover:border-slate-500/40 hover:bg-white/[.06]", variant === "ghost" && "text-slate-400 hover:bg-white/[.04] hover:text-white", variant === "danger" && "border border-rose-400/15 bg-rose-400/10 text-rose-300 hover:bg-rose-400/15", className)} {...props} />;
}

export function LinkButton({ href, children, variant = "primary", className }: { href: string; children: ReactNode; variant?: "primary" | "secondary"; className?: string }) {
  return <Link href={href} className={cn("inline-flex h-11 items-center justify-center gap-2 rounded-[10px] px-5 text-[13px] font-semibold transition duration-150", variant === "primary" ? "bg-cyan text-[#041018] shadow-[0_8px_24px_rgba(57,189,248,.16)] hover:bg-[#61cbf8] active:translate-y-px" : "border border-line bg-white/[.025] text-slate-100 hover:border-slate-500/40 hover:bg-white/[.055]", className)}>{children}</Link>;
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "cyan"; className?: string }) {
  return <span className={cn("inline-flex items-center rounded-md border px-2 py-1 text-[9px] font-semibold uppercase tracking-[.08em]", tone === "neutral" && "border-line bg-white/[.025] text-slate-400", tone === "good" && "border-emerald-400/20 bg-emerald-400/[.08] text-emerald-300", tone === "warn" && "border-amber-300/20 bg-amber-300/[.08] text-amber-200", tone === "bad" && "border-rose-400/20 bg-rose-400/[.08] text-rose-300", tone === "cyan" && "border-cyan/20 bg-cyan/[.08] text-cyan", className)}>{children}</span>;
}

export function StatCard({ label, value, detail, className }: { label: string; value: string; detail?: string; className?: string }) {
  return <div className={cn("rounded-2xl border border-line bg-panel p-4 md:p-5", className)}><p className="text-[11px] font-medium uppercase tracking-[.08em] text-slate-500">{label}</p><p className="mt-3 text-[26px] font-semibold tracking-[-.035em] text-white">{value}</p>{detail && <p className="mt-1 text-[11px] leading-5 text-slate-500">{detail}</p>}</div>;
}

export function SectionHeading({ eyebrow, title, body, action }: { eyebrow?: string; title: string; body?: string; action?: ReactNode }) {
  return <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end"><div className="min-w-0">{eyebrow && <p className="eyebrow mb-3">{eyebrow}</p>}<h2 className="text-2xl font-semibold tracking-[-.035em] text-white md:text-[30px]">{title}</h2>{body && <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">{body}</p>}</div>{action}</div>;
}

export function AddressPill({ address }: { address: string }) { return <code className="min-w-0 truncate rounded-lg border border-line bg-black/20 px-2 py-1 text-[11px] text-slate-400" title={address}>{shortAddress(address)}</code>; }
export function ArcscanLink({ hash, label }: { hash: string; label?: string }) { return <a href={`${EXPLORER_URL}/tx/${hash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-cyan hover:underline">{label ?? shortAddress(hash)} <ExternalLink className="size-3" /></a>; }

export function WarningBox({ children }: { children: ReactNode }) { return <div className="flex gap-3 rounded-xl border border-amber-300/15 bg-amber-300/[.05] p-3 text-xs leading-5 text-amber-100/75"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-300" />{children}</div>; }

export function TokenIcon({ label, image, className }: { label: string; image?: string; className?: string }) {
  return <div className={cn("relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-xl border border-cyan/20 bg-cyan/[.09] font-mono text-[11px] font-semibold text-cyan", className)}>
    {image ? <span role="img" aria-label={`${label} token image`} className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${image})` }} /> : label}
  </div>;
}

export function Progress({ value }: { value: number }) { return <div className="h-1.5 overflow-hidden rounded-full bg-white/[.06]"><div className="h-full rounded-full bg-cyan transition-all" style={{ width: `${Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))}%` }} /></div>; }

export function PageIntro({ eyebrow, title, body, children, compact = false }: { eyebrow: string; title: string; body: string; children?: ReactNode; compact?: boolean }) {
  return <div className={cn("container-shell", compact ? "pb-6 pt-9 md:pb-8 md:pt-11" : "pb-7 pt-10 md:pb-10 md:pt-14")}><div className="max-w-[680px]"><p className="eyebrow mb-3">{eyebrow}</p><h1 className={cn("font-semibold leading-[1.08] tracking-[-.05em] text-white", compact ? "text-[32px] sm:text-[38px] md:text-[42px]" : "text-[34px] sm:text-[42px] md:text-[50px]")}>{title}</h1><p className={cn("max-w-xl text-slate-400", compact ? "mt-3 text-sm leading-6" : "mt-4 text-[15px] leading-7")}>{body}</p>{children}</div></div>;
}

export function EmptyState({ title, body }: { title: string; body: string }) { return <div className="panel p-10 text-center"><p className="font-semibold text-white">{title}</p><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">{body}</p></div>; }
export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn("panel", className)} {...props} />; }
