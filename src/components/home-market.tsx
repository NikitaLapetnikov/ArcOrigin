"use client";

import { useFactoryTokenIndex } from "@/hooks/use-factory-token-index";
import { TokenTable } from "./token-table";
import { WarningBox } from "./ui";

export function HomeMarket() {
  const { tokens: indexedTokens, loading, error, isCached, isPartial } = useFactoryTokenIndex();
  const onchainState = isPartial
    ? "unavailable"
    : indexedTokens.length > 0 && (isCached || loading)
      ? "cached"
      : loading
        ? "loading"
        : indexedTokens.length > 0 ? "live" : "unavailable";
  return <>{error && <div className="mb-4"><WarningBox>{error}</WarningBox></div>}<TokenTable tokens={indexedTokens} compact onchainState={onchainState}/></>;
}
