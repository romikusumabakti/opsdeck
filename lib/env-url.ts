import { and, eq } from "drizzle-orm";
import { getProjectRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { environments, projects } from "@/lib/db/schema";
import { requestCache } from "@/server/context";
import { notFound } from "@/server/errors";

// Resolve a readable environment URL (`/CMEM/prod/…`) to its environment id.
// `requestCache()` dedupes the lookup within a request so every handler and
// helper can call it freely. Throws a 404 when the key/slug don't match, or the
// caller can't see the project (an invisible project doesn't exist).
export const resolveEnvIdByKeySlug = requestCache(
  async (projectKey: string, envSlug: string): Promise<string> => {
    const project = await db.query.projects.findFirst({
      where: { key: projectKey.toUpperCase() },
      columns: { id: true },
    });
    if (!project) notFound();
    if (!(await getProjectRole({ projectId: project.id }))) notFound();
    const [env] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(
        and(
          eq(environments.projectId, project.id),
          eq(environments.slug, envSlug.toLowerCase())
        )
      )
      .limit(1);
    if (!env) notFound();
    return env.id;
  }
);

// The reverse: an environment id → its `{ projectKey, envSlug }` readable parts,
// for the legacy `/projects/[id]` redirect shim and for link generators that
// only hold an env id. Returns null when the id is unknown.
export const resolveKeySlugById = requestCache(
  async (
    envId: string
  ): Promise<{ projectKey: string; envSlug: string } | null> => {
    const [row] = await db
      .select({ slug: environments.slug, key: projects.key })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(eq(environments.id, envId))
      .limit(1);
    return row ? { projectKey: row.key, envSlug: row.slug } : null;
  }
);
