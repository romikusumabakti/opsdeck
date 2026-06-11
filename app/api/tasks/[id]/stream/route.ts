import { type NextRequest, NextResponse } from "next/server";
import { getTaskSnapshot } from "@/actions/tasks";
import { getServerSession } from "@/lib/auth-session";

// Streamed updates require Node runtime (Edge has stricter timeouts and no
// long-lived I/O). We poll the DB instead of LISTEN/NOTIFY because the same
// snapshot pattern feeds the initial page render — keeping one source of truth
// is simpler than juggling pub/sub.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 1000;
// Cap a single SSE connection at 10 minutes to avoid leaking sockets when a
// browser silently disappears. Clients reconnect via EventSource on close.
const MAX_DURATION_MS = 10 * 60 * 1000;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = await params;

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let aborted = false;
      const onAbort = () => {
        aborted = true;
      };
      req.signal.addEventListener("abort", onAbort);

      function send(event: string, data: unknown) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
          return true;
        } catch {
          return false;
        }
      }

      try {
        let lastSerialized = "";
        while (!aborted) {
          if (Date.now() - startedAt > MAX_DURATION_MS) {
            send("timeout", { reason: "max-duration" });
            break;
          }

          let task: Awaited<ReturnType<typeof getTaskSnapshot>>;
          try {
            task = await getTaskSnapshot(id);
          } catch (err) {
            // Surface transient DB errors as an `error` event and stop. Without
            // this the throw escapes, the stream closes with no signal, and the
            // browser's EventSource silently reconnects into the same failure
            // (tight reconnect loop). Message is generic to avoid leaking DB
            // internals; the real error is logged server-side.
            console.error("task stream snapshot failed:", err);
            send("error", { message: "snapshot failed" });
            break;
          }
          if (!task) {
            send("not-found", { id });
            break;
          }

          // Diff suppression: only emit when the snapshot actually changed.
          // Saves bytes for long polls where output rarely updates.
          const serialized = JSON.stringify(task);
          if (serialized !== lastSerialized) {
            if (!send("snapshot", task)) break;
            lastSerialized = serialized;
          }

          if (task.status !== "started") break;

          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      } finally {
        req.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // already closed by abort
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disables proxy buffering (nginx) so events flush immediately.
      "X-Accel-Buffering": "no",
    },
  });
}
