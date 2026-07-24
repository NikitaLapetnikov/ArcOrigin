"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { useHolderSnapshot } from "@/hooks/use-holder-snapshot";
import { ARC_TESTNET_CONTRACTS, EXPLORER_URL, factoryForLaunchBlock } from "@/lib/chains";
import type { TokenData } from "@/lib/types";
import { shortAddress, utcDateTime } from "@/lib/utils";
import { Badge, Button, Progress } from "./ui";

type AddressItem = {
  label: string;
  address?: string;
  description: string;
};

export function TokenInfoPanel({ token }: { token: TokenData }) {
  const { snapshot, loading, error, refresh } = useHolderSnapshot(token, true);
  const [copied, setCopied] = useState("");
  const factory = token.factoryAddress ?? factoryForLaunchBlock(token.launchBlock);
  const addresses: AddressItem[] = [
    { label: "Token", address: token.address, description: "ERC-20 contract" },
    { label: "Curve", address: token.curveAddress, description: "Trading contract" },
    { label: "Creator", address: token.creator, description: "Launch wallet" },
    { label: "Factory", address: factory, description: "Contract deployer" },
    { label: "USDC", address: ARC_TESTNET_CONTRACTS.usdc, description: "Quote asset" },
    { label: "Fee vault", address: ARC_TESTNET_CONTRACTS.feeVault, description: "Protocol fees" },
    { label: "Registry", address: ARC_TESTNET_CONTRACTS.creatorRegistry, description: "Creator record" },
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

  const creatorPercent = snapshot?.creatorPercent ?? token.creatorAllocationPercent;
  const concentration = snapshot?.topTenExcludingCurvePercent;
  const curvePercent = snapshot?.curvePercent;

  return <section className="panel overflow-hidden rounded-xl shadow-none">
    <div className="flex items-center justify-between border-b border-line bg-black/10 px-4 py-3">
      <div>
        <p className="text-sm font-semibold text-white">Token info</p>
        <p className="mt-0.5 font-mono text-[9px] text-slate-600">Verified on Arc Testnet</p>
      </div>
    </div>

    <div className="border-b border-line p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-600">Distribution</p>
          <p className="mt-1 text-[11px] text-slate-500">
            {snapshot ? `Confirmed at block ${snapshot.indexedBlock}` : "Loads quietly from confirmed transfers"}
          </p>
        </div>
        <Button
          variant="ghost"
          className="h-8 px-2 text-[10px]"
          disabled={loading}
          onClick={() => void refresh(true)}
        >
          <RefreshCw className={`size-3 ${loading ? "animate-spin" : ""}`} />
          {snapshot ? "Refresh" : "Load"}
        </Button>
      </div>
      <div className="grid gap-2.5">
        <DistributionRow label="Creator" value={creatorPercent} />
        <DistributionRow label="Top 10 excluding curve" value={concentration} />
        <DistributionRow label="Trading curve" value={curvePercent} />
      </div>
      {error && <p className="mt-3 text-[10px] leading-4 text-amber-200/70">Holder data will retry in the background. Trading is unaffected.</p>}
    </div>

    <div className="border-b border-line p-4">
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

    <div className="p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[.14em] text-slate-600">Launch provenance</p>
          <p className="mt-1 text-[11px] text-slate-400">{token.launchedAt ? utcDateTime(token.launchedAt) : "Confirmed factory launch"}</p>
        </div>
        <Badge tone="good"><ShieldCheck className="mr-1 size-3" />Factory verified</Badge>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-slate-500">
        <span>Block {token.launchBlock ?? "—"}</span>
        <span>·</span>
        <span>{token.creatorAllocationPercent === undefined ? "Creator allocation unavailable" : `${token.creatorAllocationPercent}% creator allocation`}</span>
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

function DistributionRow({ label, value }: { label: string; value?: number }) {
  return <div>
    <div className="mb-1.5 flex items-center justify-between text-[10px]">
      <span className="text-slate-500">{label}</span>
      <span className="text-slate-300">{value === undefined ? "—" : `${value.toFixed(2)}%`}</span>
    </div>
    <Progress value={value ?? 0} />
  </div>;
}
