import type { Address } from "viem";

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;
const FEE_DENOMINATOR = 1_000_000n;
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
const START_MARKET_CAP = 5_000n * 10n ** 6n;
const TICK_SPACING = 200;
const MIN_USABLE_TICK = -887_200;
const MAX_USABLE_TICK = 887_200;

export type ArcOriginPoolQuoteState = {
  sqrtPriceX96: bigint;
  activeBoundarySqrtPriceX96: bigint;
  liquidity: bigint;
  tokenIsToken0: boolean;
};

function integerSqrt(value: bigint) {
  if (value < 0n) throw new Error("Square root requires a non-negative value.");
  if (value < 2n) return value;
  let estimate = 1n << BigInt(Math.ceil(value.toString(2).length / 2));
  while (true) {
    const next = (estimate + value / estimate) >> 1n;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

function initialSqrtPriceX96(tokenIsToken0: boolean) {
  const amount0 = tokenIsToken0 ? TOTAL_SUPPLY : START_MARKET_CAP;
  const amount1 = tokenIsToken0 ? START_MARKET_CAP : TOTAL_SUPPLY;
  return integerSqrt(amount1 * Q192 / amount0);
}

function approximateSqrtRatioAtTick(tick: number) {
  const ratio = Math.pow(1.0001, tick / 2) * 2 ** 96;
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error("ArcOrigin launch tick is outside the supported range.");
  return BigInt(Math.floor(ratio));
}

/**
 * Reconstructs the immutable ArcOrigin launch position from the same constants
 * used by the Factory. Floating point is used only to recover the tick-boundary
 * ratio; its relative error is far below one basis point. All quote arithmetic
 * remains bigint and the UI applies its separate slippage floor.
 */
export function arcOriginPoolQuoteState(
  token: Address,
  usdc: Address,
  indexedSqrtPriceX96?: bigint | null,
): ArcOriginPoolQuoteState {
  const tokenIsToken0 = BigInt(token) < BigInt(usdc);
  const launchSqrtPriceX96 = initialSqrtPriceX96(tokenIsToken0);
  const normalizedSqrtPrice = Number(launchSqrtPriceX96) / 2 ** 96;
  const launchTick = Math.floor(2 * Math.log(normalizedSqrtPrice) / Math.log(1.0001));
  const tickFloor = Math.floor(launchTick / TICK_SPACING) * TICK_SPACING;
  const tickLower = tokenIsToken0 ? tickFloor + TICK_SPACING : MIN_USABLE_TICK;
  const tickUpper = tokenIsToken0 ? MAX_USABLE_TICK : tickFloor;
  const sqrtLowerX96 = approximateSqrtRatioAtTick(tickLower);
  const sqrtUpperX96 = approximateSqrtRatioAtTick(tickUpper);
  const liquidity = tokenIsToken0
    ? TOTAL_SUPPLY * sqrtLowerX96 * sqrtUpperX96 / (Q96 * (sqrtUpperX96 - sqrtLowerX96))
    : TOTAL_SUPPLY * Q96 / (sqrtUpperX96 - sqrtLowerX96);
  if (liquidity <= 0n) throw new Error("ArcOrigin launch liquidity is invalid.");

  const activeBoundarySqrtPriceX96 = tokenIsToken0 ? sqrtLowerX96 : sqrtUpperX96;
  const currentSqrtPriceX96 = indexedSqrtPriceX96 && indexedSqrtPriceX96 > 0n
    ? indexedSqrtPriceX96
    : activeBoundarySqrtPriceX96;
  return {
    sqrtPriceX96: currentSqrtPriceX96,
    activeBoundarySqrtPriceX96,
    liquidity,
    tokenIsToken0,
  };
}

/**
 * Quotes against ArcOrigin's permanent single-sided V3 position. The locked
 * position is always present; any additional active liquidity can only improve
 * execution relative to this conservative quote.
 */
export function quoteArcOriginExactInput(
  state: ArcOriginPoolQuoteState,
  side: "Buy" | "Sell",
  input: bigint,
  fee: number,
) {
  if (input <= 0n) throw new Error("Quote input must be positive.");
  if (!Number.isInteger(fee) || fee < 0 || BigInt(fee) >= FEE_DENOMINATOR) {
    throw new Error("Uniswap fee is invalid.");
  }
  const amountInAfterFee = input * (FEE_DENOMINATOR - BigInt(fee)) / FEE_DENOMINATOR;
  if (amountInAfterFee <= 0n) throw new Error("Quote input is too small after fees.");

  const tokenInIsToken0 = side === "Buy" ? !state.tokenIsToken0 : state.tokenIsToken0;
  const { liquidity, sqrtPriceX96 } = state;
  let nextSqrtPriceX96: bigint;
  let output: bigint;
  if (tokenInIsToken0) {
    nextSqrtPriceX96 = liquidity * Q96 * sqrtPriceX96
      / (liquidity * Q96 + amountInAfterFee * sqrtPriceX96);
    if (side === "Sell" && state.tokenIsToken0 && nextSqrtPriceX96 < state.activeBoundarySqrtPriceX96) {
      nextSqrtPriceX96 = state.activeBoundarySqrtPriceX96;
    }
    output = liquidity * (sqrtPriceX96 - nextSqrtPriceX96) / Q96;
  } else {
    nextSqrtPriceX96 = sqrtPriceX96 + amountInAfterFee * Q96 / liquidity;
    if (side === "Sell" && !state.tokenIsToken0 && nextSqrtPriceX96 > state.activeBoundarySqrtPriceX96) {
      nextSqrtPriceX96 = state.activeBoundarySqrtPriceX96;
    }
    output = liquidity * (nextSqrtPriceX96 - sqrtPriceX96) * Q96
      / (nextSqrtPriceX96 * sqrtPriceX96);
  }
  if (output <= 0n) throw new Error("The indexed pool state returned zero output.");
  return output;
}
