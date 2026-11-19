import { eq } from "drizzle-orm";
import { getProjectRole } from "@/lib/authz";
import { db } from "@/lib/db";
import { environments, projects } from "@/lib/db/schema";
import { resolveEnvironmentBySlug } from "@/lib/environment-slug";
import { requestCache } from "@/server/context";
import { notFound } from "@/server/errors";

// Resolve a readable environment URL (`/CMEM/prod/…`) to its environment, an
// old slug (an alias left by a rename) included: `projectKey` and `envSlug`
// are then the environment's current ones, which the client redirects to.
// `requestCache()` dedupes the lookup within a request so every handler and
// helper can call it freely. Throws a 404 when the key/slug don't match, or the
// caller can't see the project (an invisible project doesn't exist).
export const resolveEnvByKeySlug = requestCache(
  async (
    projectKey: string,
    envSlug: string
  ): Promise<{
    environmentId: string;
    projectKey: string;
    envSlug: string;
    viaAlias: boolean;
  }> => {
    const project = await db.query.projects.findFirst({
      where: { key: projectKey.toUpperCase() },
      columns: { id: true, key: true },
    });
    if (!project) notFound();
    if (!(await getProjectRole({ projectId: project.id }))) notFound();
    const resolved = await resolveEnvironmentBySlug(project.id, envSlug);
    if (!resolved) notFound();
    const { environment } = resolved;
    // An alias of an environment that moved to another project since.
    const key =
      environment.projectId === project.id
        ? project.key
        : (
            await db.query.projects.findFirst({
              where: { id: environment.projectId },
              columns: { key: true },
            })
          )?.key;
    if (!key) notFound();
    return {
      environmentId: environment.id,
      projectKey: key,
      envSlug: resolved.canonicalSlug,
      viaAlias: resolved.viaAlias,
    };
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
