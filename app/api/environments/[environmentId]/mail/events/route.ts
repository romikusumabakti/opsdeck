import type { NextRequest } from "next/server";
import { mailpitAuthHeaders, mailpitEventsUrl } from "@/lib/mailpit/client";
import { mailEventType } from "@/lib/mailpit/events";
import { authorizeMailRoute } from "@/lib/mailpit/route";

// Relays the environment's Mailpit /api/events WebSocket to the browser as
// SSE, so the inbox refreshes when mail arrives. Same shape as the log stream
// route: capped duration + heartbeat, and EventSource reconnects on close.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DURATION_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
// Reconnect delay the browser uses after a drop — keeps a down Mailpit from
// being hammered by every open inbox tab.
const RETRY_MS = 10_000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ environmentId: string }> }
) {
  const { environmentId } = await params;
  const auth = await authorizeMailRoute(environmentId);
  if (!auth.ok) return auth.response;
  const { cfg } = auth;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let socket: WebSocket | null = null;

      function enqueue(payload: string) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      }

      function send(event: string, data: unknown) {
        enqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }

      const heartbeat = setInterval(
        () => enqueue(": ping\n\n"),
        HEARTBEAT_INTERVAL_MS
      );
      const maxDuration = setTimeout(() => {
        send("timeout", { reason: "max-duration" });
        tearDown();
      }, MAX_DURATION_MS);

      function tearDown() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(maxDuration);
        try {
          socket?.close();
        } catch {
          // already closed
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      }

      req.signal.addEventListener("abort", tearDown);
      enqueue(`retry: ${RETRY_MS}\n\n`);

      try {
        // Bun and Node (undici) both accept a non-standard `headers` init —
        // the only way to send Basic Auth on the upgrade request.
        socket = new WebSocket(mailpitEventsUrl(cfg.url), {
          headers: mailpitAuthHeaders(cfg),
        } as unknown as string[]);
      } catch (err) {
        send("stream-error", {
          message: err instanceof Error ? err.message : "Failed to connect",
        });
        tearDown();
        return;
      }

      socket.addEventListener("open", () => send("ready", {}));
      socket.addEventListener("message", (event) => {
        const type = mailEventType(event.data);
        if (type) send("mail", { type });
      });
      socket.addEventListener("error", () => {
        send("stream-error", { message: "Mailpit event stream failed" });
        tearDown();
      });
      socket.addEventListener("close", tearDown);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
