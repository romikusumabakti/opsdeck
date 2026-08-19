import { eq } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { decryptSecret } from "@/lib/secrets";
import {
  createTerminalHandlers,
  type TerminalTarget,
} from "@/lib/terminal/server";
import { openSshShell } from "@/lib/terminal/ssh-shell";

// Entry point for the terminal sidecar. Bundled by the Dockerfile with
// `--conditions react-server`, which resolves the "server-only" guard in
// lib/db, lib/secrets and lib/activity to its empty stub — so this process
// reuses the app's data layer verbatim instead of duplicating it.

// Validated here rather than in lib/env.ts: `validateEnv()` runs only in the
// Next app process (from instrumentation.ts), which never reads this variable.
// A check there would be dead code; this is the process that would break.
const port = Number(process.env.TERMINAL_WS_PORT ?? 3001);
if (!Number.isInteger(port) || port <= 0 || port >= 65_536) {
  throw new Error(
    `TERMINAL_WS_PORT must be a TCP port number (1-65535), got ${process.env.TERMINAL_WS_PORT}`
  );
}

// The browser's origin is the app's public URL, which the app already knows as
// BETTER_AUTH_URL. Unset (local dev over plain `bun run terminal`) skips the
// check rather than blocking every connection.
const allowedOrigin = process.env.BETTER_AUTH_URL
  ? new URL(process.env.BETTER_AUTH_URL).origin
  : null;

const { fetch, websocket, registry } = createTerminalHandlers({
  allowedOrigin,

  async loadServer(serverId: string): Promise<TerminalTarget | null> {
    const [row] = await db
      .select()
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      host: row.host,
      username: row.username,
      password: decryptSecret(row.password),
    };
  },

  openShell: (target, options) => openSshShell(target, options),

  // Who opened a shell where, and for how long. Never what was typed or
  // printed — see the design doc.
  audit(event) {
    if (event.kind === "open") {
      void recordActivity({
        actorId: event.userId,
        action: "terminal.open",
        entityType: "server",
        entityId: event.target.id,
        data: { server: event.target.name, host: event.target.host },
      });
      return;
    }
    if (event.kind === "close") {
      void recordActivity({
        actorId: event.userId,
        action: "terminal.close",
        entityType: "server",
        entityId: event.target.id,
        data: {
          server: event.target.name,
          seconds: Math.round(event.durationMs / 1000),
          reason: event.reason,
        },
      });
      return;
    }
    void recordActivity({
      actorId: event.userId,
      action: "terminal.denied",
      entityType: "server",
      // `entityId` lands in a uuid column: an unverifiable ticket names no
      // server, and undefined stores NULL where "" would be rejected outright
      // — and recordActivity swallows its own errors, so the row would simply
      // never appear.
      entityId: event.serverId ?? undefined,
      data: {
        reason: event.reason,
        ...(event.serverName ? { server: event.serverName } : {}),
      },
    });
  },
});

const server = Bun.serve({ port, hostname: "0.0.0.0", fetch, websocket });
console.log(`terminal sidecar listening on :${server.port}`);

// A single session's stray error must never take down the sidecar — every
// other user's live root shell is in this process.
process.on("uncaughtException", (error) => {
  console.error("terminal sidecar uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
  console.error("terminal sidecar unhandled rejection:", reason);
});

// Close the shells rather than letting the container's SIGKILL orphan them.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    registry.destroyAll("shutdown");
    server.stop(true);
    // Don't exit immediately: destroyAll's close-audit inserts are
    // fire-and-forget, and exiting here loses every one of them on a redeploy.
    // The loop drains on its own (timers are unref'd, the listener is closed);
    // this is only a backstop against a wedged insert.
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
