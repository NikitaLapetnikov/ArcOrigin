import { NextResponse } from "next/server";
import { getProductionHealth } from "@/lib/server/production-health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const health = await getProductionHealth();
  return NextResponse.json(health, {
    status: health.status === "error" ? 503 : 200,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
