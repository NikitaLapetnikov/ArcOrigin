import { NextRequest, NextResponse } from "next/server";
import { decodeEventLog, formatUnits, isHash, parseAbiItem } from "viem";
import { ARC_ACTIVE_FACTORY } from "@/lib/chains";
import { factoryAbi } from "@/lib/contracts";
import { createArcPublicClient } from "@/lib/onchain/arc-rpc";
import type { LiveIndexerEvent } from "@/lib/indexer/live-event";
import { isSameOriginRequest, readLimitedText } from "@/lib/server/request-security";
import { publishVerifiedLiveEvent } from "@/lib/server/live-event-hub";
import { invalidateSnapshotsForLiveEvent } from "@/lib/server/live-snapshot-invalidation";
import { resolveTokenMetadata } from "@/lib/server/token-metadata-resolver";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 512;
const publicClient = createArcPublicClient(process.env.ARC_MAINNET_RPC_URL, 8_000);
const tokenInitializedEvent = parseAbiItem(
  "event TokenInitialized(address indexed token, address indexed creator, uint256 totalSupply, string metadataURI)",
);
const automaticBuybackConfiguredEvent = parseAbiItem(
  "event AutomaticBuybackConfigured(address indexed token, uint256 indexed positionId, bool enabled)",
);

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "Cross-origin launch announcements are not allowed." }, { status: 403 });
  }
  try {
    const body = JSON.parse(await readLimitedText(request, MAX_BODY_BYTES)) as { transactionHash?: unknown };
    if (typeof body.transactionHash !== "string" || !isHash(body.transactionHash)) {
      return NextResponse.json({ error: "A valid launch transaction hash is required." }, { status: 400 });
    }
    const receipt = await publicClient.getTransactionReceipt({ hash: body.transactionHash });
    if (receipt.status !== "success") {
      return NextResponse.json({ error: "The launch transaction did not succeed." }, { status: 422 });
    }

    let launch: {
      token: `0x${string}`;
      pool: `0x${string}`;
      creator: `0x${string}`;
      name: string;
      symbol: string;
      positionId: bigint;
      logIndex: number;
    } | null = null;
    let initialized: { token: `0x${string}`; creator: `0x${string}`; totalSupply: bigint; metadataURI: string } | null = null;
    let automaticBuyback = false;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === ARC_ACTIVE_FACTORY.toLowerCase()) {
        try {
          const decoded = decodeEventLog({ abi: factoryAbi, eventName: "TokenLaunched", data: log.data, topics: log.topics });
          launch = { ...decoded.args, logIndex: log.logIndex };
          continue;
        } catch {
          // The Factory emits several event types during one launch.
        }
        try {
          const decoded = decodeEventLog({ abi: [automaticBuybackConfiguredEvent], data: log.data, topics: log.topics });
          automaticBuyback = decoded.args.enabled;
        } catch {
          // Ignore unrelated Factory events.
        }
      } else {
        try {
          const decoded = decodeEventLog({ abi: [tokenInitializedEvent], data: log.data, topics: log.topics });
          initialized = {
            token: decoded.args.token,
            creator: decoded.args.creator,
            totalSupply: decoded.args.totalSupply,
            metadataURI: decoded.args.metadataURI,
          };
        } catch {
          // Ignore constructor and ERC-20 logs.
        }
      }
    }
    if (!launch || !initialized || initialized.totalSupply <= 0n || initialized.metadataURI.length > 512) {
      return NextResponse.json({ error: "Verified ArcOrigin launch events were not found." }, { status: 422 });
    }
    if (initialized.token.toLowerCase() !== launch.token.toLowerCase()
      || initialized.creator.toLowerCase() !== launch.creator.toLowerCase()) {
      return NextResponse.json({ error: "Token initialization does not match the Factory launch." }, { status: 422 });
    }
    if (initialized.metadataURI.length === 0) {
      return NextResponse.json({ error: "The launched token has no metadata URI." }, { status: 422 });
    }
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    const metadata = await resolveTokenMetadata(initialized.metadataURI);
    const event: LiveIndexerEvent = {
      id: `${receipt.transactionHash.toLowerCase()}:${launch.logIndex}`,
      kind: "launch",
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      transactionHash: receipt.transactionHash,
      logIndex: launch.logIndex,
      timestamp: Number(block.timestamp),
      tokenAddress: launch.token,
      poolAddress: launch.pool,
      creator: launch.creator,
      name: launch.name,
      symbol: launch.symbol,
      positionId: launch.positionId.toString(),
      automaticBuyback,
      totalSupply: Number(formatUnits(initialized.totalSupply, 18)),
      metadataURI: initialized.metadataURI,
      ...metadata,
    };
    invalidateSnapshotsForLiveEvent(event);
    const published = await publishVerifiedLiveEvent(event);
    return NextResponse.json({ event, published }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "The confirmed launch could not be announced yet; the indexer will retry automatically." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
