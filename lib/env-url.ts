import "server-only";

import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { cache } from "react";
import { db } from "@/lib/db";
import { environments, projects } from "@/lib/db/schema";

// Resolve a readable environment URL (`/CMEM/prod/…`) to its environment id.
// `cache()` dedupes the lookup within a request so the layout and every page in
// the tree can call it freely. Calls `notFound()` when the key/slug don't match.
export const resolveEnvIdByKeySlug = cache(
  async (projectKey: string, envSlug: string): Promise<string> => {
    const project = await db.query.projects.findFirst({
      where: { key: projectKey.toUpperCase() },
      columns: { id: true },
    });
    if (!project) notFound();
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
export const resolveKeySlugById = cache(
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
