import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { routeOrgGuard } from "@/lib/authz";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { resolveTerminalCwd } from "@/lib/terminal/authorize";
import { mintTicket } from "@/lib/terminal/protocol";
import { sessionRouter } from "@/server/router";

const bodySchema = z.object({
  serverId: z.uuid(),
  cwd: z.string().max(4096).optional(),
});

/**
 * Mints the short-lived credential the terminal sidecar accepts (ported from
 * app/api/terminal/ticket). This route is the single authorization decision
 * for the feature: the sidecar only checks a signature, so anything it must
 * not do has to be refused here.
 */
export const terminalRouter = sessionRouter().post("/ticket", async (c) => {
  // Checked here as well as on the page, because this route is directly
  // callable. The ticket TTL is 30 s, so this is the only check.
  const guard = await routeOrgGuard({ server: ["terminal"] });
  if (!guard.ok) return guard.response;
  const { session } = guard;

  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return new Response("Invalid input", { status: 400 });
  }

  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, parsed.data.serverId))
    .limit(1);
  if (!server) return new Response("Not found", { status: 404 });

  const cwd = resolveTerminalCwd(server.sftpRoot, parsed.data.cwd);
  if (!cwd.ok) {
    await recordActivity({
      actorId: session.user.id,
      action: "terminal.denied",
      entityType: "server",
      entityId: server.id,
      data: { server: server.name, reason: "cwd" },
    });
    return new Response("Invalid path", { status: 400 });
  }

  const ticket = mintTicket({
    uid: session.user.id,
    sid: server.id,
    cwd: cwd.cwd,
  });
  // No-store: a ticket is single-use and valid for 30s; a cached copy is only
  // ever a liability.
  return c.json({ ticket }, 200, { "Cache-Control": "no-store" });
});
