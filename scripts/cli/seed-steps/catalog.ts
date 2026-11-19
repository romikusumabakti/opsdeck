// Servers, projects, apps with their components, and environments.
import { and, desc, eq, or, sql } from "drizzle-orm";
import { generateKeyBetween } from "fractional-indexing";
import {
  appComponents,
  apps,
  ciConnections,
  environments,
  issues,
  projectApps,
  projectComponentBranches,
  projectGroups,
  projects,
  servers,
} from "@/lib/db/schema";
import {
  appByKey,
  DEMO_APPS,
  DEMO_CI_CONNECTION,
  DEMO_ENVIRONMENTS,
  DEMO_PROJECTS,
  DEMO_SERVERS,
  type DemoProject,
  environmentUrl,
} from "../seed-data/catalog";
import { ORIGINAL_ISSUES } from "../seed-data/issues";
import { addDays } from "../seed-data/random";
import { count, type SeedContext } from "./context";

export async function seedServers(ctx: SeedContext): Promise<void> {
  const { tx } = ctx;
  for (const host of DEMO_SERVERS) {
    const [existing] = await tx
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.host, host));
    if (existing) {
      ctx.servers.set(host, existing.id);
      continue;
    }
    const [row] = await tx
      .insert(servers)
      .values({
        name: host.replace(/\.invalid$/, ""),
        host,
        username: "demo",
        // A dummy: nothing can connect, so the value only has to be a valid
        // envelope under this instance's SECRETS_KEY.
        password: ctx.encryptSecret(ctx.newPassword()),
        placement: "open",
      })
      .returning({ id: servers.id });
    if (!row) throw new Error(`Server ${host} was not created`);
    ctx.servers.set(host, row.id);
    count(ctx, "servers");
  }
}

/**
 * The demo projects. A project with a demo key that this run did not create
 * is seeded further only when it is recognisably demo data: the demo app is
 * already among its sources, or it carries the seed's name and either the
 * seed's group (its legacy client) or (as the first seed wrote it, without a client) one of
 * the first seed's sample issues. Any other project with that key belongs
 * to someone; nothing is added under it.
 */
export async function seedProjects(ctx: SeedContext): Promise<void> {
  const { tx } = ctx;
  for (const project of DEMO_PROJECTS) {
    // A project the seed already owns keeps its row, group included; only a
    // project created now is filed under its group.
    const [exists] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.key, project.key));
    const [inserted] = await tx
      .insert(projects)
      .values({
        key: project.key,
        name: project.name,
        groupId: exists ? null : await ensureGroup(ctx, project.group),
        description: project.description,
        defaultServerId: ctx.servers.get(project.defaultServer) ?? null,
        createdAt: addDays(ctx.now, -35),
        updatedAt: addDays(ctx.now, -35),
      })
      .onConflictDoNothing()
      .returning({ id: projects.id, name: projects.name });
    if (inserted) {
      count(ctx, "projects");
      ctx.projects.set(project.key, inserted);
      continue;
    }
    const [row] = await tx
      .select({ id: projects.id, name: projects.name, client: projects.client })
      .from(projects)
      .where(eq(projects.key, project.key));
    if (!row) throw new Error(`Project ${project.key} was not created`);
    const [source] = await tx
      .select({ appId: projectApps.appId })
      .from(projectApps)
      .innerJoin(apps, eq(apps.id, projectApps.appId))
      .where(
        and(eq(projectApps.projectId, row.id), eq(apps.appKey, project.app))
      );
    if (!source && !(await isOldDemoProject(ctx, row, project))) {
      ctx.lines.push(`skipped ${project.key} (not demo data)`);
      continue;
    }
    ctx.projects.set(project.key, { id: row.id, name: row.name });
  }
}

/**
 * The group with this name (ignoring case and surrounding spaces, as the
 * unique index does), created last in the order when it does not exist.
 */
async function ensureGroup(ctx: SeedContext, name: string): Promise<string> {
  const { tx } = ctx;
  const match = sql`lower(trim(${projectGroups.name})) = lower(trim(${name}))`;
  const [found] = await tx
    .select({ id: projectGroups.id })
    .from(projectGroups)
    .where(match);
  if (found) return found.id;
  const [last] = await tx
    .select({ rank: projectGroups.rank })
    .from(projectGroups)
    .orderBy(desc(projectGroups.rank))
    .limit(1);
  const [created] = await tx
    .insert(projectGroups)
    .values({ name, rank: generateKeyBetween(last?.rank ?? null, null) })
    .returning({ id: projectGroups.id });
  if (!created) throw new Error(`Group ${name} was not created`);
  count(ctx, "projectGroups");
  return created.id;
}

/** Seed name plus the seed's group, or no client and a first-seed issue. */
async function isOldDemoProject(
  ctx: SeedContext,
  row: { id: string; name: string; client: string | null },
  project: DemoProject
): Promise<boolean> {
  if (row.name !== project.name) return false;
  if (row.client === project.group) return true;
  if (row.client !== null) return false;
  const original = ORIGINAL_ISSUES.map((i) =>
    and(eq(issues.number, i.number), eq(issues.title, i.title))
  );
  const [match] = await ctx.tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.projectId, row.id), or(...original)))
    .limit(1);
  return match !== undefined;
}

/**
 * A placeholder CI connection (required by app_components), the demo apps
 * and their components, and each project's source app and default branches.
 */
export async function seedApps(ctx: SeedContext): Promise<void> {
  const { tx } = ctx;
  const ci = await tx
    .insert(ciConnections)
    .values({ ...DEMO_CI_CONNECTION })
    .onConflictDoNothing()
    .returning({ id: ciConnections.id });
  count(ctx, "ciConnections", ci.length);
  const [connection] = await tx
    .select({ id: ciConnections.id })
    .from(ciConnections)
    .where(eq(ciConnections.name, DEMO_CI_CONNECTION.name));
  if (!connection) throw new Error("Demo CI connection was not created");

  for (const app of DEMO_APPS) {
    const inserted = await tx
      .insert(apps)
      .values({ appKey: app.appKey, name: app.name })
      .onConflictDoNothing()
      .returning({ id: apps.id });
    count(ctx, "apps", inserted.length);
    const [row] = await tx
      .select({ id: apps.id })
      .from(apps)
      .where(eq(apps.appKey, app.appKey));
    if (!row) throw new Error(`App ${app.appKey} was not created`);
    ctx.apps.set(app.appKey, row.id);
    for (const component of app.components) {
      const added = await tx
        .insert(appComponents)
        .values({
          componentKey: component.componentKey,
          appId: row.id,
          ciConnectionId: connection.id,
          repoFullName: component.repoFullName,
          bundleImage: component.bundleImage,
          // Each component has a repository of its own, so the default
          // secret name applies (lib/ci notifySecretNameFor).
          notifySecret: ctx.encryptSecret(ctx.newPassword()),
          createdAt: addDays(ctx.now, -35),
        })
        .onConflictDoNothing()
        .returning({ key: appComponents.componentKey });
      count(ctx, "appComponents", added.length);
    }
  }

  for (const project of DEMO_PROJECTS) {
    const projectId = ctx.projects.get(project.key)?.id;
    const appId = ctx.apps.get(project.app);
    if (!projectId || !appId) continue;
    const source = await tx
      .insert(projectApps)
      .values({ projectId, appId, createdAt: addDays(ctx.now, -35) })
      .onConflictDoNothing()
      .returning({ appId: projectApps.appId });
    count(ctx, "projectApps", source.length);
    const branchRows = appByKey(project.app).components.map((c) => ({
      projectId,
      componentKey: c.componentKey,
      branch: project.branch,
      updatedAt: addDays(ctx.now, -35),
    }));
    if (branchRows.length === 0) continue;
    const branches = await tx
      .insert(projectComponentBranches)
      .values(branchRows)
      .onConflictDoNothing()
      .returning({ key: projectComponentBranches.componentKey });
    count(ctx, "projectComponentBranches", branches.length);
  }
}

/** Dev, QA and Demo for every project; an existing one is kept as it is. */
export async function seedEnvironments(ctx: SeedContext): Promise<void> {
  const { tx } = ctx;
  for (const project of DEMO_PROJECTS) {
    const projectId = ctx.projects.get(project.key)?.id;
    if (!projectId) continue;
    const appId = ctx.apps.get(project.app) ?? null;
    const rows = DEMO_ENVIRONMENTS.map((e) => ({
      ...e,
      createdSlug: e.slug,
      projectId,
      appId,
      url: environmentUrl(project, e.slug),
    }));
    if (rows.length === 0) continue;
    const inserted = await tx
      .insert(environments)
      .values(rows)
      .onConflictDoNothing()
      .returning({ id: environments.id });
    count(ctx, "environments", inserted.length);
    for (const e of DEMO_ENVIRONMENTS) {
      const [row] = await tx
        .select({
          id: environments.id,
          name: environments.name,
          appId: environments.appId,
        })
        .from(environments)
        .where(
          and(
            eq(environments.projectId, projectId),
            eq(environments.slug, e.slug)
          )
        );
      if (row) ctx.environments.set(`${project.key}/${e.slug}`, row);
    }
  }
}
