import type { IndexedEvent } from "./events";

export function normalizeEvent(event: IndexedEvent) {
  return {
    ...event,
    id: [
      event.address.toLowerCase(),
      event.transactionHash.toLowerCase(),
      event.logIndex,
      event.name,
    ].join(":"),
    blockHash: event.blockHash.toLowerCase() as `0x${string}`,
    blockNumber: event.blockNumber.toString(),
  };
}
