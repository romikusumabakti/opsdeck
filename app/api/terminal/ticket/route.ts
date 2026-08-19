import { eq } from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { getServerSession, isAdmin } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { servers } from "@/lib/db/schema";
import { resolveTerminalCwd } from "@/lib/terminal/authorize";
import { mintTicket } from "@/lib/terminal/protocol";

// Mints the short-lived credential the terminal sidecar accepts. This route is
// the single authorization decision for the feature: the sidecar only checks a
// signature, so anything it must not do has to be refused here.
//
// Node runtime: lib/db and lib/secrets are server-only and Edge can't run them.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  serverId: z.uuid(),
  cwd: z.string().max(4096).optional(),
});

export async function POST(req: NextRequest) {
  const session = await getServerSession();
  // Admin-only, matching the file explorer. Checked here as well as on the
  // page, because this route is directly callable.
  if (!session || !isAdmin(session)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return new NextResponse("Invalid input", { status: 400 });
  }

  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, parsed.data.serverId))
    .limit(1);
  if (!server) return new NextResponse("Not found", { status: 404 });

  const cwd = resolveTerminalCwd(server.sftpRoot, parsed.data.cwd);
  if (!cwd.ok) {
    await recordActivity({
      actorId: session.user.id,
      action: "terminal.denied",
      entityType: "server",
      entityId: server.id,
      data: { server: server.name, reason: "cwd" },
    });
    return new NextResponse("Invalid path", { status: 400 });
  }

  const ticket = mintTicket({
    uid: session.user.id,
    sid: server.id,
    cwd: cwd.cwd,
  });
  // No-store: a ticket is single-use and valid for 30s; a cached copy is only
  // ever a liability.
  return NextResponse.json(
    { ticket },
    { headers: { "Cache-Control": "no-store" } }
  );
}
