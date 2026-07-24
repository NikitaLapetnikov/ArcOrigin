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
  const [mounted, setMounted] = useState(false);
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const connector = connectors.find((item) => item.name === "Rabby") ?? connectors[0];

  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return <Button variant="secondary" disabled><Wallet className="size-4" />Connect wallet</Button>;
  }

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
      "relative rounded-lg px-3.5 py-2 text-[13px] font-medium transition",
      active ? "bg-white/[.06] text-white" : "text-slate-400 hover:bg-white/[.03] hover:text-slate-100",
    )}
  >{label}</Link>;
}

export function Header() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);

  return <header className="sticky top-0 z-50 border-b border-line/70 bg-ink/80 backdrop-blur-2xl">
    <div className="container-shell flex h-16 items-center justify-between gap-4">
      <Link href="/" className="flex items-center gap-2.5">
        <Image
          src="/brand/arcorigin-logo.png"
          alt="ArcOrigin"
          width={36}
          height={36}
          priority
          className="size-9 rounded-[10px] border border-cyan/15 shadow-[0_0_24px_rgba(57,189,248,.14)]"
        />
        <span className="text-[15px] font-semibold tracking-[-.025em] text-white">ArcOrigin</span>
      </Link>
      <nav className="hidden items-center gap-1 lg:flex">
        {nav.map(([label, href]) => <NavLink key={href} label={label} href={href} path={path} />)}
      </nav>
      <div className="hidden items-center gap-2 md:flex">
        <Badge tone="neutral" className="hidden gap-1.5 xl:inline-flex"><Radio className="size-3 text-emerald-400" />Arc Testnet</Badge>
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
