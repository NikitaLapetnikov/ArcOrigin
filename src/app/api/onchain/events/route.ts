import { subscribeLiveEvents } from "@/lib/server/live-event-hub";
import { replayPayloadsAfter } from "@/lib/indexer/live-event";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEARTBEAT_MS = 15_000;

function sseFrame(event: string, data: string, id?: string) {
  return `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${data}\n\n`;
}

function eventId(payload: string) {
  try {
    const parsed = JSON.parse(payload) as { id?: unknown };
    return typeof parsed.id === "string" && parsed.id.length <= 160 ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

export async function GET(request: Request) {
  if (!process.env.REDIS_URL?.trim()) {
    return Response.json({ error: "Live event delivery is not configured." }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let unsubscribe: () => void = () => undefined;

    const enqueue = (frame: string) => {
      if (closed || !controller) return;
      try {
        controller.enqueue(encoder.encode(frame));
      } catch {
        void cleanup();
      }
    };
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      request.signal.removeEventListener("abort", abort);
      unsubscribe();
    };
    const abort = () => { void cleanup(); };

    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        enqueue("retry: 2000\n\n");
        heartbeat = setInterval(() => enqueue(`: heartbeat ${Date.now()}\n\n`), HEARTBEAT_MS);
        request.signal.addEventListener("abort", abort, { once: true });
      },
      cancel() {
        return cleanup();
      },
    });
    const subscription = await subscribeLiveEvents((payload) => {
      enqueue(sseFrame("arc-event", payload, eventId(payload)));
    }).catch(async (error) => {
      await cleanup();
      throw error;
    });
    unsubscribe = subscription.unsubscribe;
    if (subscription.status) enqueue(sseFrame("indexer-status", subscription.status));
    const replay = replayPayloadsAfter(
      subscription.recent,
      request.headers.get("last-event-id"),
    );
    for (const payload of replay) {
      enqueue(sseFrame("arc-event", payload, eventId(payload)));
    }
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json({ error: "Live event delivery is temporarily unavailable." }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
