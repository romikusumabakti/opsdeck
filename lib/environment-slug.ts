import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { environmentSlugAliases, environments } from "@/lib/db/schema";

// Which environment a `/[key]/[slug]` names: the one whose slug it is now,
// else the one that had it before a rename (environment_slug_aliases). No
// permission check: callers check access to the environment they get.

type Executor = Pick<typeof db, "select">;

export type ResolvedEnvironmentSlug = {
  environment: { id: string; projectId: string; slug: string };
  /** The environment's current slug, for the readable URL to redirect to. */
  canonicalSlug: string;
  /** True when `slug` is an old slug of the environment, not its current one. */
  viaAlias: boolean;
};

/**
 * The environment `slug` names in the project (matched lowercase), or null.
 * A current slug wins over an alias. An alias keeps naming its environment
 * after the environment moved to another project: `environment.projectId`
 * is then not `projectId`.
 */
export async function resolveEnvironmentBySlug(
  projectId: string,
  slug: string,
  executor: Executor = db
): Promise<ResolvedEnvironmentSlug | null> {
  const wanted = slug.toLowerCase();
  const columns = {
    id: environments.id,
    projectId: environments.projectId,
    slug: environments.slug,
  };
  const [current] = await executor
    .select(columns)
    .from(environments)
    .where(
      and(eq(environments.projectId, projectId), eq(environments.slug, wanted))
    )
    .limit(1);
  if (current) {
    return {
      environment: current,
      canonicalSlug: current.slug,
      viaAlias: false,
    };
  }
  const [aliased] = await executor
    .select(columns)
    .from(environmentSlugAliases)
    .innerJoin(
      environments,
      eq(environments.id, environmentSlugAliases.environmentId)
    )
    .where(
      and(
        eq(environmentSlugAliases.projectId, projectId),
        eq(environmentSlugAliases.slug, wanted)
      )
    )
    .limit(1);
  if (!aliased) return null;
  return { environment: aliased, canonicalSlug: aliased.slug, viaAlias: true };
}

/** Every slug the project uses: current slugs and aliases alike. */
export async function projectSlugsInUse(
  projectId: string,
  executor: Executor = db
): Promise<Set<string>> {
  const [current, aliases] = await Promise.all([
    executor
      .select({ slug: environments.slug })
      .from(environments)
      .where(eq(environments.projectId, projectId)),
    executor
      .select({ slug: environmentSlugAliases.slug })
      .from(environmentSlugAliases)
      .where(eq(environmentSlugAliases.projectId, projectId)),
  ]);
  return new Set([...current, ...aliases].map((row) => row.slug));
}
