import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { normalizeDisplayName } from "@/lib/validation";

// Display names are unique among active users (case-insensitive), because
// mentions resolve by exact @name. Account creation must never fail on a
// clash, so creation paths pick the first free variant.
const MAX = 100;

/** The name a new account starts from: normalised, else the email local part. */
export function baseDisplayName(
  name: string | null | undefined,
  email: string
): string {
  return normalizeDisplayName(name ?? "") || (email.split("@")[0] ?? "");
}

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

/** Whether an active user other than `exceptId` already has this name. */
export async function nameTaken(
  name: string,
  exceptId?: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.banned, false),
        sql`lower(${users.name}) = lower(${name})`,
        exceptId ? ne(users.id, exceptId) : undefined
      )
    )
    .limit(1);
  return Boolean(row);
}

export async function pickFreeName(
  name: string | null | undefined,
  email: string
): Promise<string> {
  const base = baseDisplayName(name, email);
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = disambiguateName(base, email, attempt);
    if (!(await nameTaken(candidate))) return candidate;
  }
  // 50 identical names is not a real directory; let the unique index decide.
  return disambiguateName(base, email, 50);
}
