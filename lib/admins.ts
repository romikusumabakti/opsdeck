import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

// Ids of the active (non-banned) org admins. Feeds the last-admin guard
// (lib/access.ts). Lives outside server/services, where every
// export is a candidate API endpoint.
export async function listActiveAdminIds(): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.banned, false)));
  return rows.map((r) => r.id);
}
