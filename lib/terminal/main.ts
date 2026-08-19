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

const port = Number(process.env.TERMINAL_WS_PORT ?? 3001);

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
      entityId: event.serverId,
      data: { reason: event.reason },
    });
  },
});

const server = Bun.serve({ port, hostname: "0.0.0.0", fetch, websocket });
console.log(`terminal sidecar listening on :${server.port}`);

// Close the shells rather than letting the container's SIGKILL orphan them.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    registry.destroyAll("shutdown");
    server.stop(true);
    process.exit(0);
  });
}
