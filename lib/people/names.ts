import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

// Display names are unique among active users (case-insensitive), because
// mentions resolve by exact @name. Account creation must never fail on a
// clash, so creation paths pick the first free variant.
const MAX = 100;

export function disambiguateName(
  name: string,
  email: string,
  attempt: number
): string {
  if (attempt === 0) return name.slice(0, MAX);
  const local = email.split("@")[0] ?? "";
  const suffix = attempt === 1 ? ` (${local})` : ` (${local}) ${attempt}`;
  return name.slice(0, MAX - suffix.length) + suffix;
}

export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
}

async function nameTaken(name: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.banned, false), sql`lower(${users.name}) = lower(${name})`)
    )
    .limit(1);
  return Boolean(row);
}

export async function pickFreeName(
  name: string,
  email: string
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = disambiguateName(name.trim(), email, attempt);
    if (!(await nameTaken(candidate))) return candidate;
  }
  // 50 identical names is not a real directory; let the unique index decide.
  return disambiguateName(name.trim(), email, 50);
}
