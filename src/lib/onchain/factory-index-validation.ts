export function hasCompleteFactoryLaunchSet(actualLaunches: number, expectedLaunches: bigint) {
  return Number.isSafeInteger(actualLaunches)
    && actualLaunches >= 0
    && expectedLaunches >= 0n
    && expectedLaunches <= BigInt(Number.MAX_SAFE_INTEGER)
    && BigInt(actualLaunches) === expectedLaunches;
}
