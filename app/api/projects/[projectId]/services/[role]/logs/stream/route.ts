import { type NextRequest, NextResponse } from "next/server";
import { getProjectById } from "@/actions/projects";
import { getServerSession } from "@/lib/auth-session";
import {
  buildFollowLogsCommand,
  getServiceConfig,
  LOG_LINE_OPTIONS,
  type LogLines,
  type ServiceRole,
} from "@/lib/services";
import { streamRemoteCommand } from "@/lib/ssh";

// Streams `docker logs -f` / `kubectl logs -f` / `journalctl -fu` output as
// SSE. Same shape as the task streams: clients use EventSource and get
// auto-reconnect for free. Node runtime is required — Edge can't keep a
// long-lived ssh2 socket open.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cap each stream at 10 minutes. EventSource on the client auto-reconnects
// on close, which also lets us release SSH sockets held by silently-departed
// tabs. Aligned with the task stream cap.
const MAX_DURATION_MS = 10 * 60 * 1000;
// Heartbeat comment so reverse proxies (and the browser EventSource) don't
// idle-timeout the connection when logs are quiet.
const HEARTBEAT_INTERVAL_MS = 15_000;

const VALID_ROLES: ReadonlyArray<ServiceRole> = ["db", "backend", "frontend"];

function parseLines(raw: string | null): LogLines {
  const n = Number(raw);
  if (LOG_LINE_OPTIONS.includes(n as never)) return n as LogLines;
  return 200;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string; role: string }> }
) {
  const session = await getServerSession();
  if (!session) return new NextResponse("Unauthorized", { status: 401 });

  const { projectId, role } = await params;
  if (!VALID_ROLES.includes(role as ServiceRole)) {
    return new NextResponse("Invalid role", { status: 400 });
  }

  const project = await getProjectById(projectId);
  if (!project) return new NextResponse("Not found", { status: 404 });

  const lines = parseLines(req.nextUrl.searchParams.get("lines"));
  const cfg = getServiceConfig(project, role as ServiceRole);
  const command = buildFollowLogsCommand(
    cfg.serviceType,
    cfg.serviceName,
    lines,
    cfg.server.password
  );

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let stopHandle: { stop: () => void } | null = null;
      let heartbeatTimer: NodeJS.Timeout | null = null;
      let maxDurationTimer: NodeJS.Timeout | null = null;
      // Last partial line carried over between chunks. SSH delivers arbitrary
      // byte boundaries, not line-aligned, so we accumulate until we see \n.
      let partial = "";

      function safeEnqueue(payload: string): boolean {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(payload));
          return true;
        } catch {
          closed = true;
          return false;
        }
      }

      function send(event: string, data: unknown) {
        return safeEnqueue(
          `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        );
      }

      function tearDown() {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (maxDurationTimer) clearTimeout(maxDurationTimer);
        try {
          stopHandle?.stop();
        } catch {
          // already stopped
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      }

      req.signal.addEventListener("abort", tearDown);

      heartbeatTimer = setInterval(() => {
        // SSE comment frame — ignored by EventSource but keeps the socket alive.
        safeEnqueue(": ping\n\n");
      }, HEARTBEAT_INTERVAL_MS);

      maxDurationTimer = setTimeout(() => {
        send("timeout", { reason: "max-duration" });
        tearDown();
      }, MAX_DURATION_MS);

      try {
        stopHandle = await streamRemoteCommand(
          {
            host: cfg.server.host,
            username: cfg.server.username,
            password: cfg.server.password,
          },
          command,
          {
            onChunk(chunk) {
              if (closed) return;
              const text = partial + chunk.toString("utf8");
              const parts = text.split("\n");
              partial = parts.pop() ?? "";
              if (parts.length === 0) return;
              // Batch all complete lines in this chunk into one event to keep
              // SSE overhead low when output is bursty.
              send("lines", parts);
            },
            onClose(info) {
              if (closed) return;
              if (partial.length > 0) {
                send("lines", [partial]);
                partial = "";
              }
              send("close", info);
              tearDown();
            },
            onError(err) {
              if (closed) return;
              send("stream-error", { message: err.message });
              tearDown();
            },
          }
        );
        // SSH channel is open at this point — safe to tell the client we're
        // streaming. Sent after streamRemoteCommand resolves so a connect
        // failure goes through the catch branch instead.
        send("ready", {
          role,
          serviceType: cfg.serviceType,
          lines,
          startedAt: new Date(startedAt).toISOString(),
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to open log stream";
        send("stream-error", { message });
        tearDown();
      }
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
