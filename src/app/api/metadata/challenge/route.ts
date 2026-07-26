import { NextRequest, NextResponse } from "next/server";
import { createMetadataChallenge, MetadataUploadError } from "@/lib/server/metadata-upload";
import { isSameOriginRequest, readLimitedText, requestClientKey } from "@/lib/server/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_CHALLENGE_BYTES = 1_024;

export async function POST(request: NextRequest) {
  try {
    if (!isSameOriginRequest(request)) throw new MetadataUploadError("Cross-origin upload requests are not allowed.", 403);
    const body = JSON.parse(await readLimitedText(request, MAX_CHALLENGE_BYTES)) as {
      address?: unknown;
      commitment?: unknown;
    };
    if (typeof body.address !== "string" || typeof body.commitment !== "string") {
      throw new MetadataUploadError("Wallet and metadata commitment are required.");
    }
    return NextResponse.json(createMetadataChallenge(body.address, body.commitment, requestClientKey(request)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof MetadataUploadError
      ? error.status
      : error instanceof Error && error.message === "Request body is too large."
        ? 413
        : 400;
    const message = error instanceof MetadataUploadError ? error.message : "Invalid upload challenge request.";
    return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
