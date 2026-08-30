export const indexedEventNames = ["TokenLaunched", "TokenCrossed", "PermanentLiquidityLocked", "Swap", "FeesCollected", "FeeReceived", "FeeWithdrawn", "CreatorRegistered", "Transfer"] as const;
export type IndexedEventName = (typeof indexedEventNames)[number];
export type IndexedEvent = {
  name: IndexedEventName;
  address: `0x${string}`;
  blockNumber: bigint;
  blockHash: `0x${string}`;
  transactionHash: `0x${string}`;
  logIndex: number;
  args: Record<string, unknown>;
};
