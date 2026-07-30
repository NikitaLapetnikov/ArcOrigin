import { isHash, type Hash } from "viem";

export type CanonicalCheckpoint = {
  indexedBlock: string;
  indexedBlockHash: Hash;
};

export type CanonicalCheckpointStatus =
  | "canonical"
  | "orphaned"
  | "invalid"
  | "unavailable";

type BlockIdentity = {
  hash: Hash | null;
};

type BlockReader = (blockNumber: bigint) => Promise<BlockIdentity>;

function parseCheckpointBlock(value: string) {
  if (!/^\d+$/.test(value)) return null;
  const blockNumber = BigInt(value);
  return blockNumber >= 0n ? blockNumber : null;
}

export async function createCanonicalCheckpoint(
  indexedBlock: bigint,
  readBlock: BlockReader,
): Promise<CanonicalCheckpoint> {
  const block = await readBlock(indexedBlock);
  if (!block.hash) throw new Error("Canonical block hash is unavailable.");
  return {
    indexedBlock: indexedBlock.toString(),
    indexedBlockHash: block.hash,
  };
}

export async function upgradeLegacyCanonicalCheckpoint<
  T extends { indexedBlock?: unknown; indexedBlockHash?: unknown },
>(
  snapshot: T | null | undefined,
  readBlock: BlockReader,
): Promise<T | null> {
  if (
    !snapshot
    || typeof snapshot.indexedBlock !== "string"
    || snapshot.indexedBlockHash !== undefined
  ) return null;
  const blockNumber = parseCheckpointBlock(snapshot.indexedBlock);
  if (blockNumber === null) return null;
  try {
    const checkpoint = await createCanonicalCheckpoint(blockNumber, readBlock);
    return { ...snapshot, indexedBlockHash: checkpoint.indexedBlockHash };
  } catch {
    return null;
  }
}

export async function getCanonicalCheckpointStatus(
  checkpoint: Partial<CanonicalCheckpoint> | null | undefined,
  readBlock: BlockReader,
): Promise<CanonicalCheckpointStatus> {
  if (
    !checkpoint
    || typeof checkpoint.indexedBlock !== "string"
    || typeof checkpoint.indexedBlockHash !== "string"
    || !isHash(checkpoint.indexedBlockHash)
  ) return "invalid";
  const blockNumber = parseCheckpointBlock(checkpoint.indexedBlock);
  if (blockNumber === null) return "invalid";
  try {
    const block = await readBlock(blockNumber);
    return (
      block.hash
      && block.hash.toLowerCase() === checkpoint.indexedBlockHash.toLowerCase()
    ) ? "canonical" : "orphaned";
  } catch {
    return "unavailable";
  }
}

export async function isCanonicalCheckpoint(
  checkpoint: Partial<CanonicalCheckpoint> | null | undefined,
  readBlock: BlockReader,
) {
  return await getCanonicalCheckpointStatus(checkpoint, readBlock) === "canonical";
}
