import { ARCORIGIN_ACTIVE_GRADUATION_TARGET_USDC, ARC_TESTNET_ACTIVE_FACTORY } from "@/lib/chains";
import type { TokenData } from "@/lib/types";

export function isCurrentV4Token(token: TokenData) {
  return token.factoryAddress?.toLowerCase() === ARC_TESTNET_ACTIVE_FACTORY.toLowerCase()
    && Math.abs(token.targetUSDC - ARCORIGIN_ACTIVE_GRADUATION_TARGET_USDC) < 0.000001;
}

export function currentV4Tokens(tokens: TokenData[]) {
  return tokens.filter(isCurrentV4Token);
}
