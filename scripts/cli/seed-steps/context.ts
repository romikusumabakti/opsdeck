// State the demo seed steps share inside one transaction: the ids they
// resolved (or created) and how many rows each area inserted.
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PersonRef } from "../seed-data/issues";

export type Tx = Parameters<
  Parameters<PostgresJsDatabase["transaction"]>[0]
>[0];

export interface SeedEnvironment {
  id: string;
  name: string;
  /** Created by this seed or an earlier one (it deploys a demo service). */
  seeded: boolean;
}

export interface SeedContext {
  tx: Tx;
  now: Date;
  encryptSecret: (plaintext: string) => string;
  newPassword: () => string;
  emailDomain: string;
  servers: Map<string, string>;
  // Only projects the seed owns (created now, or recognised as demo data).
  projects: Map<string, { id: string; name: string }>;
  // Keyed by `${projectKey}/${slug}`.
  environments: Map<string, SeedEnvironment>;
  // Only people that exist: a staff member whose name an unrelated user
  // already holds is left out, and so is everything only they would author.
  people: Map<PersonRef, { id: string; name: string }>;
  inserted: Record<string, number>;
  // For the operator, printed only after the transaction commits.
  lines: string[];
}

export function count(ctx: SeedContext, area: string, n = 1): void {
  ctx.inserted[area] = (ctx.inserted[area] ?? 0) + n;
}

export const personId = (
  ctx: SeedContext,
  ref: PersonRef | undefined
): string | null => (ref ? (ctx.people.get(ref)?.id ?? null) : null);
