import { inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { appComponents } from "@/lib/db/schema";
import { loadProjectSources } from "@/lib/project-sources";
import type { AssistantSource } from "./sources";

/**
 * "Project branches": every service in the project's Sources (in use or
 * not), at the project's branch for it, else the build spec's
 * fallback branch. Nothing is deployed from this view, so the commit is the
 * branch head, resolved by the snapshot step. A component without a CI
 * connection is kept: the snapshot step reports it unavailable, as for an
 * environment.
 */
export async function resolveProjectSources(
  projectId: string
): Promise<AssistantSource[]> {
  const components = await loadProjectSources(projectId);
  if (components.length === 0) return [];

  const rows = await db
    .select({
      componentKey: appComponents.componentKey,
      ciConnectionId: appComponents.ciConnectionId,
    })
    .from(appComponents)
    .where(
      inArray(
        appComponents.componentKey,
        components.map((c) => c.componentKey)
      )
    );
  const connectionOf = new Map(
    rows.map((row) => [row.componentKey, row.ciConnectionId])
  );

  return components.map((component) => ({
    componentKey: component.componentKey,
    repoFullName: component.repoFullName,
    ciConnectionId: connectionOf.get(component.componentKey) ?? null,
    commitSha: null,
    ref: component.defaultBranch ?? component.fallbackBranch,
    deployed: false,
    deployedAt: null,
  }));
}
