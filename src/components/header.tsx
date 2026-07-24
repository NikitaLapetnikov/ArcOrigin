"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Menu, Radio, Wallet, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { arcTestnet } from "@/lib/chains";
import { cn, shortAddress } from "@/lib/utils";
import { Badge, Button } from "./ui";

const nav = [
  ["Markets", "/tokens"],
  ["Launch", "/launch"],
  ["Docs", "/docs"],
] as const;

function WalletButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const connector = connectors.find((item) => item.name === "Rabby") ?? connectors[0];

  if (isConnected && chainId !== arcTestnet.id) {
    return <Button variant="secondary" onClick={() => switchChain({ chainId: arcTestnet.id })}>Switch to Arc</Button>;
  }
  if (isConnected) {
    return <Button variant="secondary" onClick={() => disconnect()}><span className="size-2 rounded-full bg-emerald-400" />{shortAddress(address ?? "")}</Button>;
  }

  return <div className="flex items-center gap-2">
    <Button title={error?.message} onClick={() => connector && connect({ connector })} disabled={isPending || !connector}>
      <Wallet className="size-4" />{isPending ? "Connecting" : `Connect ${connector?.name ?? "wallet"}`}
    </Button>
    {error && <span className="hidden max-w-44 text-[10px] leading-4 text-rose-300 xl:block">{error.message.split("\n")[0]}</span>}
  </div>;
}

function NavLink({ href, label, path, onClick }: { href: string; label: string; path: string; onClick?: () => void }) {
  const active = path === href || path.startsWith(`${href}/`);
  return <Link
    href={href}
    onClick={onClick}
    aria-current={active ? "page" : undefined}
    className={cn(
      "rounded-xl px-4 py-2 text-sm font-semibold transition",
      active ? "bg-white/[.085] text-white shadow-sm" : "text-slate-400 hover:bg-white/[.035] hover:text-white",
    )}
  >{label}</Link>;
}

export function Header() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);

  return <header className="sticky top-0 z-50 border-b border-line/80 bg-ink/85 backdrop-blur-2xl">
    <div className="container-shell flex h-[68px] items-center justify-between gap-4">
      <Link href="/" className="flex items-center gap-2.5">
        <Image
          src="/brand/arcorigin-logo.png"
          alt="ArcOrigin"
          width={40}
          height={40}
          priority
          className="size-10 rounded-xl border border-cyan/20 shadow-[0_0_28px_rgba(71,173,255,.18)]"
        />
        <span className="text-[15px] font-extrabold tracking-[-.025em] text-white">ArcOrigin</span>
      </Link>
      <nav className="hidden items-center gap-1 rounded-2xl border border-line bg-white/[.025] p-1 lg:flex">
        {nav.map(([label, href]) => <NavLink key={href} label={label} href={href} path={path} />)}
      </nav>
      <div className="hidden items-center gap-2 md:flex">
        <Badge tone="good" className="hidden gap-1.5 xl:inline-flex"><Radio className="size-3" />Arc Testnet ready</Badge>
        <WalletButton />
      </div>
      <button
        className="grid size-10 place-items-center rounded-xl border border-line text-slate-300 lg:hidden"
        onClick={() => setOpen(!open)}
        aria-label="Toggle navigation"
        aria-expanded={open}
        aria-controls="mobile-navigation"
      >{open ? <X className="size-5" /> : <Menu className="size-5" />}</button>
    </div>
    {open && <div id="mobile-navigation" className="container-shell grid gap-1 border-t border-line py-3 lg:hidden">
      {nav.map(([label, href]) => <NavLink key={href} label={label} href={href} path={path} onClick={() => setOpen(false)} />)}
      <div className="my-2 h-px bg-line md:hidden" />
      <div className="mt-2 md:hidden"><WalletButton /></div>
    </div>}
  </header>;
}
