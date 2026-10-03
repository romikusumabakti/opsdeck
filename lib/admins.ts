import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

// Ids of the active (non-banned) org admins. Feeds the last-admin guard
// (lib/access.ts). Lives outside the "use server" action files, where every
// export would be a public endpoint.
export async function listActiveAdminIds(): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.banned, false)));
  return rows.map((r) => r.id);
}
