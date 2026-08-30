import {
  ARCORIGIN_ACTIVE_GRADUATION_TARGET_USDC,
  ARCORIGIN_PROTOCOL_VERSION,
  ARC_ACTIVE_FACTORY,
} from "@/lib/chains";
import type { TokenData } from "@/lib/types";

export function isCurrentV4Token(token: TokenData) {
  if (token.factoryAddress?.toLowerCase() !== ARC_ACTIVE_FACTORY.toLowerCase()) return false;
  if (ARCORIGIN_PROTOCOL_VERSION === 7) return token.venue === "uniswap-v3";
  return Math.abs(token.targetUSDC - ARCORIGIN_ACTIVE_GRADUATION_TARGET_USDC) < 0.000001;
}

export function currentV4Tokens(tokens: TokenData[]) {
  return tokens.filter(isCurrentV4Token);
}
