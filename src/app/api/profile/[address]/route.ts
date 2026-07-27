import { NextRequest, NextResponse } from "next/server";
import { ProfileError, readWalletProfile } from "@/lib/server/profile-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: NextRequest, context: { params: Promise<{ address: string }> }) {
  try {
    const { address } = await context.params;
    const profile = await readWalletProfile(address);
    return NextResponse.json({ profile }, {
      headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=300" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof ProfileError ? error.message : "Profile could not be loaded." },
      { status: error instanceof ProfileError ? error.status : 400 },
    );
  }
}
