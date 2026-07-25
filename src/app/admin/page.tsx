import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import manifest from "../../../deployment/arc-testnet.json";
import { AddressPill, Badge, PageIntro, Panel, WarningBox } from "@/components/ui";
import { EXPLORER_URL } from "@/lib/chains";

export const metadata: Metadata = { title: "Deployment Status" };

const rows = [
  ["Network", "Arc Testnet"],
  ["Chain ID", String(manifest.chainId)],
  ["RPC", "https://rpc.drpc.testnet.arc.network"],
  ["Explorer", manifest.explorerBaseUrl],
  ["Deployed", new Date(manifest.deployedAt).toLocaleString("en-GB", { timeZone: "UTC" }) + " UTC"],
  ["V4 activated", new Date(manifest.migration.activatedAt).toLocaleString("en-GB", { timeZone: "UTC" }) + " UTC"],
] as const;

const contracts = [
  ["Fee vault", manifest.contracts.feeVault],
  ["Creator registry", manifest.contracts.creatorRegistry],
  ["Active Factory (V4)", manifest.contracts.factory],
  ...manifest.legacyFactories.map((address, index) => [`Legacy Factory ${index + 1}`, address]),
  ["USDC", manifest.contracts.usdc],
] as const;

export default function AdminPage() {
  return <><PageIntro eyebrow="Read-only status" title="Deployment" body="Active Arc Testnet contracts and migration history."/><div className="container-shell pb-20"><Panel className="max-w-3xl p-5 md:p-6"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-5"><div><p className="font-semibold text-white">ArcOrigin contracts</p><p className="mt-1 text-xs text-slate-500">Committed testnet manifest</p></div><Badge tone="good">V4 active</Badge></div><dl className="mt-5 grid gap-4 text-sm">{rows.map(([label,value])=><div key={label} className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:gap-6"><dt className="text-slate-500">{label}</dt><dd className="break-safe text-slate-300 sm:text-right">{value}</dd></div>)}{contracts.map(([label,address])=><div key={label} className="flex items-center justify-between gap-4"><dt className="text-slate-500">{label}</dt><dd className="flex min-w-0 items-center gap-2"><AddressPill address={address}/><a href={`${EXPLORER_URL}/address/${address}`} target="_blank" rel="noreferrer" aria-label={`Open ${label} on Arcscan`} className="shrink-0 text-cyan"><ExternalLink className="size-3.5"/></a></dd></div>)}</dl></Panel><div className="mt-5 max-w-3xl"><WarningBox>Testnet deployment is verified but not independently audited for mainnet.</WarningBox></div></div></>;
}
