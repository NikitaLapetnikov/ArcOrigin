"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, ShieldCheck } from "lucide-react";
import { EXPLORER_URL, arcChain } from "@/lib/chains";
import type { TokenData } from "@/lib/types";
import { shortAddress, utcDateTime } from "@/lib/utils";
import { Badge } from "./ui";

type AddressItem = {
  label: string;
  address?: string;
  description: string;
};

export function TokenInfoPanel({ token }: { token: TokenData }) {
  const [copied, setCopied] = useState("");
  const addresses: AddressItem[] = [
    { label: "Token", address: token.address, description: "ERC-20 contract" },
    { label: "Creator", address: token.creator, description: "Launch wallet" },
  ];

  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(address);
      window.setTimeout(() => setCopied((current) => current === address ? "" : current), 1_600);
    } catch {
      setCopied("");
    }
  }

  return <section className="panel overflow-hidden rounded-[28px] shadow-none">
    <div className="flex items-center justify-between border-b border-line/70 px-5 py-4">
      <div>
        <p className="text-sm font-semibold text-white">Token info</p>
        <p className="mt-0.5 font-mono text-[9px] text-slate-600">Verified on {arcChain.name}</p>
      </div>
    </div>

    <div className="border-b border-line/70 px-5 py-4">
      <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-600">Contracts & wallets</p>
      <div className="mt-3 grid gap-1">
        {addresses.map((item) => item.address && <div key={item.label} className="group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-white/[.025]">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-[11px] text-slate-500">{item.label}</span>
              <code className="truncate text-[10px] text-slate-300">{shortAddress(item.address)}</code>
            </div>
            <p className="ml-[72px] mt-0.5 text-[9px] text-slate-700">{item.description}</p>
          </div>
          <button
            type="button"
            aria-label={`Copy ${item.label} address`}
            onClick={() => void copyAddress(item.address!)}
            className="grid size-7 shrink-0 place-items-center rounded-md text-slate-600 transition hover:bg-white/[.05] hover:text-white"
          >
            {copied === item.address ? <Check className="size-3.5 text-emerald-300" /> : <Copy className="size-3.5" />}
          </button>
          <a
            href={`${EXPLORER_URL}/address/${item.address}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${item.label} on Arcscan`}
            className="grid size-7 shrink-0 place-items-center rounded-md text-slate-600 transition hover:bg-white/[.05] hover:text-cyan"
          >
            <ExternalLink className="size-3.5" />
          </a>
        </div>)}
      </div>
    </div>

    <div className="px-5 py-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-600">Launch provenance</p>
          <p className="mt-1 text-[11px] text-slate-400">{token.launchedAt ? utcDateTime(token.launchedAt) : "Confirmed factory launch"}</p>
        </div>
        <Badge tone="good"><ShieldCheck className="mr-1 size-3" />Factory verified</Badge>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-500">
        <span>Block {token.launchBlock ?? "—"}</span>
      </div>
      {token.launchTxHash && <a
        href={`${EXPLORER_URL}/tx/${token.launchTxHash}`}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-cyan hover:underline"
      >
        Open launch transaction <ExternalLink className="size-3" />
      </a>}
    </div>
  </section>;
}
