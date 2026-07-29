import type { Metadata } from "next";
import { ExternalLink } from "lucide-react";
import { FeeVaultWithdrawal } from "@/components/fee-vault-withdrawal";
import { AddressPill, Badge, PageIntro, Panel } from "@/components/ui";
import {
  ARCORIGIN_PROTOCOL_VERSION,
  ARC_ACTIVE_CONTRACTS,
  ARC_ACTIVE_FACTORY_BLOCK,
  EXPLORER_URL,
  arcChain,
} from "@/lib/chains";

export const metadata: Metadata = { title: "Deployment Status" };

const protocolLabel = `V${ARCORIGIN_PROTOCOL_VERSION}`;
const rows = [
  ["Network", arcChain.name],
  ["Chain ID", String(arcChain.id)],
  ["Factory deployment block", ARC_ACTIVE_FACTORY_BLOCK.toString()],
  ["Explorer", EXPLORER_URL],
] as const;
const contracts = [
  ["Fee vault", ARC_ACTIVE_CONTRACTS.feeVault],
  ["Creator registry", ARC_ACTIVE_CONTRACTS.creatorRegistry],
  [`Active Factory (${protocolLabel})`, ARC_ACTIVE_CONTRACTS.factory],
  ["USDC", ARC_ACTIVE_CONTRACTS.usdc],
] as const;

export default function AdminPage() {
  return <>
    <PageIntro
      eyebrow="Protocol operations"
      title="Deployment"
      body={`Active ${arcChain.name} contracts and authorized Fee Vault withdrawal.`}
    />
    <div className="container-shell pb-20">
      <Panel className="max-w-3xl p-5 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-5">
          <div>
            <p className="font-semibold text-white">ArcOrigin contracts</p>
            <p className="mt-1 text-xs text-slate-500">Selected network deployment</p>
          </div>
          <Badge tone="good">{protocolLabel} active</Badge>
        </div>
        <dl className="mt-5 grid gap-4 text-sm">
          {rows.map(([label, value]) => <div key={label} className="flex flex-col gap-1 sm:flex-row sm:justify-between sm:gap-6">
            <dt className="text-slate-500">{label}</dt>
            <dd className="break-safe text-slate-300 sm:text-right">{value}</dd>
          </div>)}
          {contracts.map(([label, address]) => <div key={label} className="flex items-center justify-between gap-4">
            <dt className="text-slate-500">{label}</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <AddressPill address={address} />
              <a
                href={`${EXPLORER_URL}/address/${address}`}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${label} in the explorer`}
                className="shrink-0 text-cyan"
              >
                <ExternalLink className="size-3.5" />
              </a>
            </dd>
          </div>)}
        </dl>
      </Panel>
      <FeeVaultWithdrawal />
    </div>
  </>;
}
