const ARC_NATIVE_USDC_DECIMALS = 18;
const ARC_USDC_PRECOMPILE_DECIMALS = 6;
const ARC_USDC_NATIVE_SCALE = 10n ** BigInt(
  ARC_NATIVE_USDC_DECIMALS - ARC_USDC_PRECOMPILE_DECIMALS,
);

/**
 * Arc exposes the native gas balance through the canonical six-decimal USDC
 * precompile. Convert a precompile amount before combining it with gas cost.
 */
export function requiredNativeUsdcBalance(
  gas: bigint,
  feePerGas: bigint,
  requiredUsdc = 0n,
) {
  return gas * feePerGas + requiredUsdc * ARC_USDC_NATIVE_SCALE;
}
