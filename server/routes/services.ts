import { z } from "zod";
import { routeProjectGuard } from "@/lib/authz";
import { loadEnvironmentWithServers } from "@/lib/environments";
import {
  buildFollowLogsCommand,
  getServiceConfig,
  LOG_LINE_OPTIONS,
  type LogLines,
  type ServiceRole,
} from "@/lib/services";
import { type SshStreamHandle, streamRemoteCommand } from "@/lib/ssh";
import {
  serviceActionSchema,
  serviceRoleSchema,
  uuidSchema,
} from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  controlService,
  getAllServiceStatuses,
} from "@/server/services/services";
import { eventChannel, eventStream } from "@/server/sse";
import { json, query } from "@/server/validation";

export const servicesRouter = sessionRouter()
  .get(
    "/get-all-service-statuses",
    query(z.object({ environmentId: uuidSchema })),
    async (c) =>
      c.json(await getAllServiceStatuses(c.req.valid("query").environmentId))
  )
  .post(
    "/control-service",
    json(
      z.object({
        environmentId: uuidSchema,
        role: serviceRoleSchema,
        action: serviceActionSchema,
      })
    ),
    async (c) => {
      const { environmentId, role, action } = c.req.valid("json");
      return c.json(await controlService(environmentId, role, action));
    }
  );

// Cap each log stream at 10 minutes. EventSource on the client auto-reconnects
// on close, which also releases SSH sockets held by silently-departed tabs.
const MAX_DURATION_MS = 10 * 60 * 1000;
// Heartbeat comment so reverse proxies (and the browser EventSource) don't
// idle-timeout the connection when logs are quiet.
const HEARTBEAT_INTERVAL_MS = 15_000;

const VALID_ROLES: ReadonlyArray<ServiceRole> = ["db", "backend", "frontend"];

function parseLines(raw: string | undefined): LogLines {
  const n = Number(raw);
  const match = LOG_LINE_OPTIONS.find((opt) => opt === n);
  return match ?? 200;
}

/**
 * The service log stream ported from
 * app/api/environments/[environmentId]/services/[role]/logs/stream. Mounted at
 * /api/environments so the path is unchanged. Streams `docker logs -f` /
 * `kubectl logs -f` / `journalctl -fu` output as SSE.
 */
export const serviceLogsRouter = sessionRouter().get(
  "/:environmentId/services/:role/logs/stream",
  async (c) => {
    const { environmentId, role } = c.req.param();
    const guard = await routeProjectGuard(
      { environmentId },
      { service: ["logs"] }
    );
    if (!guard.ok) return guard.response;
    if (!VALID_ROLES.includes(role as ServiceRole)) {
      return new Response("Invalid role", { status: 400 });
    }

    // Load the full environment (with credentials) server-side — the SSH
    // password opens the log stream and must never come from the client.
    const environment = await loadEnvironmentWithServers(environmentId);
    if (!environment) return new Response("Not found", { status: 404 });

    const lines = parseLines(c.req.query("lines"));
    const cfg = getServiceConfig(environment, role as ServiceRole);
    const command = buildFollowLogsCommand(
      cfg.serviceType,
      cfg.serviceName,
      lines,
      cfg.server.password
    );
    const startedAt = Date.now();

    return eventStream(c, async (stream) => {
      let stopHandle: SshStreamHandle | null = null;
      // Last partial line carried over between chunks. SSH delivers arbitrary
      // byte boundaries, not line-aligned, so we accumulate until we see \n.
      let partial = "";
      // Frames are queued in order and flushed before the stream closes, so
      // the final `close` / `stream-error` / `timeout` always reaches the
      // client (see server/sse.ts).
      const channel = eventChannel(stream, {
        maxDurationMs: MAX_DURATION_MS,
        heartbeatMs: HEARTBEAT_INTERVAL_MS,
        onClose: () => stopHandle?.stop(),
      });
      const send = channel.send;

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
              if (channel.closed) return;
              const text = partial + chunk.toString("utf8");
              const parts = text.split("\n");
              partial = parts.pop() ?? "";
              if (parts.length === 0) return;
              // Batch all complete lines in this chunk into one event to keep
              // SSE overhead low when output is bursty.
              send("lines", parts);
            },
            onClose(info) {
              if (channel.closed) return;
              if (partial.length > 0) {
                send("lines", [partial]);
                partial = "";
              }
              send("close", info);
              channel.close();
            },
            onError(err) {
              if (channel.closed) return;
              send("stream-error", { message: err.message });
              channel.close();
            },
          }
        );
        // The client may have left while the SSH channel was opening.
        if (channel.closed) stopHandle.stop();
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
        channel.close();
      }

      await channel.done;
    });
  }
);
