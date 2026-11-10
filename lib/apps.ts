import {
  and,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { type DbExecutor, db } from "@/lib/db";
import {
  type App,
  type AppComponent,
  appComponents,
  apps,
  builds,
  deployTargets,
  environments,
} from "@/lib/db/schema";
import { COMPONENT_OTHER_APP_MESSAGE } from "@/lib/deploy/errors";
import { CodedHTTPException } from "@/server/errors";

/** A component as listed to clients: everything but the notify secret. */
export type PublicAppComponent = Omit<AppComponent, "notifySecret">;

const { notifySecret: _notifySecret, ...publicComponentColumns } =
  getTableColumns(appComponents);

/**
 * The component and its app, or undefined when the key is unknown.
 * `notifySecret` is still encrypted (see lib/secrets.ts).
 */
export async function getComponent(
  componentKey: string
): Promise<(AppComponent & { app: App }) | undefined> {
  const [row] = await db
    .select({ component: appComponents, app: apps })
    .from(appComponents)
    .innerJoin(apps, eq(apps.id, appComponents.appId))
    .where(eq(appComponents.componentKey, componentKey));
  return row && { ...row.component, app: row.app };
}

export async function listApps(): Promise<
  (App & { components: PublicAppComponent[] })[]
> {
  const rows = await db
    .select({ app: apps, component: publicComponentColumns })
    .from(apps)
    .leftJoin(appComponents, eq(appComponents.appId, apps.id))
    .orderBy(apps.appKey, appComponents.componentKey);
  const byId = new Map<string, App & { components: PublicAppComponent[] }>();
  for (const { app, component } of rows) {
    const entry = byId.get(app.id) ?? { ...app, components: [] };
    if (component) entry.components.push(component);
    byId.set(app.id, entry);
  }
  return [...byId.values()];
}

/** The projects that hold an environment of the app. */
export async function projectIdsWithAppEnvironment(
  appId: string
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ projectId: environments.projectId })
    .from(environments)
    .where(eq(environments.appId, appId));
  return rows.map((row) => row.projectId);
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

/** One app with its public components, or undefined when the key is unknown. */
export async function getApp(
  appKey: string
): Promise<(App & { components: PublicAppComponent[] }) | undefined> {
  // A handful of apps exist; reusing listApps keeps one projection to audit.
  return (await listApps()).find((app) => app.appKey === appKey);
}

export async function appKeyExists(appKey: string): Promise<boolean> {
  const rows = await db
    .select({ id: apps.id })
    .from(apps)
    .where(eq(apps.appKey, appKey))
    .limit(1);
  return rows.length > 0;
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

/** The repositories of a CI connection that already build a component. */
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
 * Inserts an app and its components in one transaction. A taken app key,
 * component key or CI repo surfaces as a unique violation.
 */
export async function insertAppWithComponents(
  app: { appKey: string; name: string },
  components: NewAppComponent[]
): Promise<void> {
  await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(apps)
      .values(app)
      .returning({ id: apps.id });
    if (!created) throw new Error("App insert returned no row");
    await tx
      .insert(appComponents)
      .values(components.map((c) => ({ ...c, appId: created.id })));
  });
}

/**
 * Inserts components into an existing app. A taken component key or CI repo
 * surfaces as a unique violation.
 */
export async function insertComponents(
  appId: string,
  components: NewAppComponent[]
): Promise<void> {
  await db
    .insert(appComponents)
    .values(components.map((c) => ({ ...c, appId })));
}

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

/**
 * An environment deploys one app: a target's component must belong to it. An
 * environment with no app yet (managed without deploy, or new) adopts the
 * component's app; the conditional UPDATE keeps two concurrent first targets
 * from setting different apps. Pass the transaction that inserts the target so
 * a failed insert leaves `app_id` unchanged.
 */
export async function assertTargetMatchesEnvironmentApp(
  environmentId: string,
  componentKey: string,
  executor: DbExecutor = db
): Promise<void> {
  const [component] = await executor
    .select({ appId: appComponents.appId })
    .from(appComponents)
    .where(eq(appComponents.componentKey, componentKey));
  if (!component) {
    throw new HTTPException(404, { message: "Component not found" });
  }
  const adopted = await executor
    .update(environments)
    .set({ appId: component.appId })
    .where(and(eq(environments.id, environmentId), isNull(environments.appId)))
    .returning({ id: environments.id });
  if (adopted.length > 0) return;
  const [environment] = await executor
    .select({ appId: environments.appId })
    .from(environments)
    .where(eq(environments.id, environmentId));
  if (!environment) {
    throw new HTTPException(404, { message: "Environment not found" });
  }
  if (environment.appId !== component.appId) {
    throw new CodedHTTPException(
      409,
      "componentOtherApp",
      COMPONENT_OTHER_APP_MESSAGE
    );
  }
}
