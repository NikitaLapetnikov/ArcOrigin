import type { IndexedEvent } from "./events";
import { normalizeEvent } from "./normalize";

export type ReconcileResult = {
  events: IndexedEvent[];
  duplicateCount: number;
  rollbackFromBlock: bigint | null;
};

function compareEvents(left: IndexedEvent, right: IndexedEvent) {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }
  if (left.logIndex !== right.logIndex) return left.logIndex - right.logIndex;
  return left.transactionHash.localeCompare(right.transactionHash);
}

function eventId(event: IndexedEvent) {
  return normalizeEvent(event).id;
}

function canonicalHashes(events: IndexedEvent[]) {
  const hashes = new Map<string, string>();
  for (const event of events) {
    const block = event.blockNumber.toString();
    const hash = event.blockHash.toLowerCase();
    const existing = hashes.get(block);
    if (existing && existing !== hash) {
      throw new Error(`Incoming events contain conflicting hashes for block ${block}.`);
    }
    hashes.set(block, hash);
  }
  return hashes;
}

/**
 * Reconciles overlapping log batches without trusting arrival order.
 *
 * Incoming block hashes are authoritative for the covered range. If an
 * existing event belongs to a different hash at the same height, every event
 * from that height onward is rolled back before the replacement batch is
 * applied. Exact duplicate logs are idempotent.
 */
export function reconcileIndexedEvents(
  existingEvents: IndexedEvent[],
  incomingEvents: IndexedEvent[],
): ReconcileResult {
  const incomingHashes = canonicalHashes(incomingEvents);
  let rollbackFromBlock: bigint | null = null;

  for (const event of existingEvents) {
    const incomingHash = incomingHashes.get(event.blockNumber.toString());
    if (
      incomingHash
      && incomingHash !== event.blockHash.toLowerCase()
      && (rollbackFromBlock === null || event.blockNumber < rollbackFromBlock)
    ) {
      rollbackFromBlock = event.blockNumber;
    }
  }

  const retained = rollbackFromBlock === null
    ? existingEvents
    : existingEvents.filter((event) => event.blockNumber < rollbackFromBlock);
  const byId = new Map<string, IndexedEvent>();
  let duplicateCount = 0;

  for (const event of [...retained, ...incomingEvents]) {
    const id = eventId(event);
    if (byId.has(id)) duplicateCount += 1;
    byId.set(id, event);
  }

  return {
    events: [...byId.values()].sort(compareEvents),
    duplicateCount,
    rollbackFromBlock,
  };
}
