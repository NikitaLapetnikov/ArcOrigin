import { NextRequest, NextResponse } from "next/server";
import { createProfileChallenge, ProfileError } from "@/lib/server/profile-store";
import { isSameOriginRequest, readLimitedText, requestClientKey } from "@/lib/server/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    if (!isSameOriginRequest(request)) throw new ProfileError("Cross-origin profile requests are not allowed.", 403);
    const body = JSON.parse(await readLimitedText(request, 1_024)) as { address?: unknown; commitment?: unknown };
    if (typeof body.address !== "string" || typeof body.commitment !== "string") {
      throw new ProfileError("Wallet and profile commitment are required.");
    }
    return NextResponse.json(createProfileChallenge(body.address, body.commitment, requestClientKey(request)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const status = error instanceof ProfileError ? error.status : 400;
    return NextResponse.json(
      { error: error instanceof ProfileError ? error.message : "Invalid profile challenge request." },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
