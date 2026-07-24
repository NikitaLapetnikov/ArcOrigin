"use client";

import { useFactoryTokenIndex } from "@/hooks/use-factory-token-index";
import { money } from "@/lib/utils";
import { Badge, EmptyState, StatCard, WarningBox } from "./ui";
import { TokenTable } from "./token-table";

export function CreatorDashboard({ address }: { address: string }) {
  const { tokens: indexedTokens, loading, error, refresh, isCached, isPartial } = useFactoryTokenIndex();
  const normalized = address.toLowerCase();
  const tokens = indexedTokens.filter((token) => token.creator.toLowerCase() === normalized);
  const volume = tokens.reduce((sum, token) => sum + token.volume24h, 0);
  const graduated = tokens.filter((token) => token.status === "Graduated").length;
  const onchainState = isPartial ? "unavailable" : isCached ? "cached" : loading ? "loading" : "live";

  if (tokens.length === 0 && loading) return <div className="container-shell pb-20"><EmptyState title="Reading Factory history…" body="Checking confirmed Arc Testnet launches for this wallet."/></div>;
  if (tokens.length === 0) return <div className="container-shell pb-20"><div className="mb-5"><WarningBox>{error || "No confirmed Factory launch was found for this wallet."}</WarningBox></div><EmptyState title="No indexed creator history" body="Only creator history confirmed by Arc Testnet Factory events is displayed."/></div>;

  return <div className="container-shell pb-20">
    <div className="mb-5 flex flex-wrap items-center gap-2">{isCached && <Badge tone="neutral">Cached profile</Badge>}<Badge tone="neutral">Unverified metadata</Badge>{tokens.length === 1 && <Badge tone="neutral">New creator</Badge>}</div>
    {error && <div className="mb-5 flex items-center gap-3"><div className="flex-1"><WarningBox>{isCached ? `Showing the last confirmed cached snapshot. ${error}` : error}</WarningBox></div><button onClick={() => void refresh()} className="shrink-0 text-xs font-semibold text-cyan">Retry live data</button></div>}
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3"><StatCard label="Indexed launches" value={String(tokens.length)} detail="Confirmed Factory events"/><StatCard label="Graduated" value={String(graduated)} detail="Confirmed curve status"/><StatCard label="Tracked volume" value={isPartial ? "—" : money(volume,true)} detail="Confirmed curve events"/></div>
    <div className="panel my-6 p-5"><p className="text-sm font-medium text-white">No creator reputation score is assigned</p><p className="mt-2 text-xs leading-5 text-slate-500">ArcOrigin displays verifiable wallet-linked launch history only. A launch count is not treated as identity verification, trust, or a prediction of future behavior.</p></div>
    <h2 className="mb-4 text-xl font-semibold text-white">Created tokens</h2><TokenTable tokens={tokens} compact onchainState={onchainState}/>
  </div>;
}
