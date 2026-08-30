import { BadgeCheck, Flame } from "lucide-react";
import { isOfficialOriginToken } from "@/lib/chains";
import type { TokenData } from "@/lib/types";
import { Badge } from "./ui";

export function TokenLabels({ token, compact = false }: { token: TokenData; compact?: boolean }) {
  const official = isOfficialOriginToken(token.address);
  if (!official && !token.automaticBuyback) return null;

  return <div className="flex flex-wrap items-center gap-1.5">
    {official && <Badge tone="cyan" className={compact ? "px-1.5 py-0.5 text-[8px]" : undefined}>
      <BadgeCheck className="mr-1 size-3" />Official ORIGIN
    </Badge>}
    {token.automaticBuyback && <Badge tone="good" className={compact ? "px-1.5 py-0.5 text-[8px]" : undefined}>
      <Flame className="mr-1 size-3" />Auto Buyback
    </Badge>}
  </div>;
}
