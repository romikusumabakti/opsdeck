import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  type AppComponent,
  appComponents,
  builds,
  deployTargets,
  environments,
} from "@/lib/db/schema";

/**
 * The component (a service) by key, or undefined when the key is unknown. Every
 * deploy-path read (build hook, deploy job, targets) goes through here, so it
 * never depends on the legacy app: a service registered without one is found
 * like any other. `notifySecret` is still encrypted (see lib/secrets.ts).
 */
export async function getComponent(
  componentKey: string
): Promise<AppComponent | undefined> {
  const [row] = await db
    .select()
    .from(appComponents)
    .where(eq(appComponents.componentKey, componentKey));
  return row;
}

/** The component's deploy targets: each one's project and source branch. */
export async function componentTargetBranches(
  componentKey: string
): Promise<{ projectId: string; sourceBranch: string }[]> {
  return db
    .selectDistinct({
      projectId: environments.projectId,
      sourceBranch: deployTargets.sourceBranch,
    })
    .from(deployTargets)
    .innerJoin(environments, eq(environments.id, deployTargets.environmentId))
    .where(eq(deployTargets.componentKey, componentKey));
}

/**
 * The newest pipeline URL a build of the component brought (any branch) that
 * points at a pipeline of Woodpecker repo `ciRepoId`, or null. Builds carry
 * CI_PIPELINE_URL, Woodpecker's public address, unlike the connection's base
 * URL, which may be internal.
 */
export async function latestComponentPipelineUrl(
  componentKey: string,
  ciRepoId: string
): Promise<string | null> {
  if (!/^[0-9]+$/.test(ciRepoId)) return null;
  const [row] = await db
    .select({ pipelineUrl: builds.pipelineUrl })
    .from(builds)
    .where(
      and(
        eq(builds.componentKey, componentKey),
        sql`${builds.pipelineUrl} ~ ${`^https?://.+/repos/${ciRepoId}/pipeline/[0-9]+$`}`
      )
    )
    .orderBy(desc(builds.receivedAt), desc(builds.id))
    .limit(1);
  return row?.pipelineUrl ?? null;
}

/** The given component keys that are already taken. */
export async function takenComponentKeys(keys: string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await db
    .select({ componentKey: appComponents.componentKey })
    .from(appComponents)
    .where(inArray(appComponents.componentKey, keys));
  return rows.map((row) => row.componentKey);
}

/**
 * The repositories of a CI connection that already build a component, one row
 * per component (a repository may build several).
 */
export async function linkedCiRepos(ciConnectionId: string): Promise<
  {
    componentKey: string;
    ciRepoId: string | null;
    repoFullName: string;
  }[]
> {
  return db
    .select({
      componentKey: appComponents.componentKey,
      ciRepoId: appComponents.ciRepoId,
      repoFullName: appComponents.repoFullName,
    })
    .from(appComponents)
    .where(eq(appComponents.ciConnectionId, ciConnectionId));
}

export type NewAppComponent = Omit<
  typeof appComponents.$inferInsert,
  "appId" | "createdAt"
>;

/**
 * Records one branch's attempt to commit the generated pipeline file, merged
 * into `pipeline_file_commits` in one statement so attempts on other branches
 * are never overwritten. A failure keeps that branch's last good sha, so the
 * UI can still show what the branch holds.
 */
export async function setPipelineFileCommit(
  componentKey: string,
  branch: string,
  result: { sha: string } | { error: string }
): Promise<void> {
  const at = new Date().toISOString();
  const column = appComponents.pipelineFileCommits;
  const entry =
    "sha" in result
      ? sql`jsonb_build_object('sha', ${result.sha}::text, 'at', ${at}::text)`
      : sql`jsonb_strip_nulls(jsonb_build_object('sha', ${column} -> ${branch}::text -> 'sha', 'error', ${result.error}::text, 'at', ${at}::text))`;
  await db
    .update(appComponents)
    .set({
      pipelineFileCommits: sql`coalesce(${column}, '{}'::jsonb) || jsonb_build_object(${branch}::text, ${entry})`,
    })
    .where(eq(appComponents.componentKey, componentKey));
}

/**
 * Appends a branch to a component's build spec in one statement, only when it
 * is not listed yet. True when it was appended.
 */
export async function appendBuildSpecBranch(
  componentKey: string,
  branch: string
): Promise<boolean> {
  const spec = appComponents.buildSpec;
  const updated = await db
    .update(appComponents)
    .set({
      buildSpec: sql`jsonb_set(${spec}, '{branches}', (${spec} -> 'branches') || to_jsonb(${branch}::text))`,
    })
    .where(
      and(
        eq(appComponents.componentKey, componentKey),
        eq(appComponents.pipelineMode, "generated"),
        sql`not ((${spec} -> 'branches') ? ${branch})`
      )
    )
    .returning({ componentKey: appComponents.componentKey });
  return updated.length > 0;
}

/** Stores a new notify secret, already encrypted with lib/secrets.ts. */
export async function setNotifySecret(
  componentKey: string,
  encryptedSecret: string
): Promise<void> {
  const updated = await db
    .update(appComponents)
    .set({ notifySecret: encryptedSecret })
    .where(eq(appComponents.componentKey, componentKey))
    .returning({ componentKey: appComponents.componentKey });
  if (updated.length === 0) throw new Error("Component not found");
}
