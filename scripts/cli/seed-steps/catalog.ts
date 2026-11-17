// Servers, projects, apps with their components, and environments.
import { and, eq } from "drizzle-orm";
import {
  appComponents,
  apps,
  ciConnections,
  environments,
  projectApps,
  projectComponentBranches,
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
  environmentUrl,
} from "../seed-data/catalog";
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
 * is seeded further only when it is recognisably demo data: the name the
 * seed gives it with the seed's client (or none, as the first seed wrote
 * it), or the demo app already among its sources. Any other project with
 * that key belongs to someone; nothing is added under it.
 */
export async function seedProjects(ctx: SeedContext): Promise<void> {
  const { tx } = ctx;
  for (const project of DEMO_PROJECTS) {
    const [inserted] = await tx
      .insert(projects)
      .values({
        key: project.key,
        name: project.name,
        client: project.client,
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
    const named =
      row.name === project.name &&
      (row.client === null || row.client === project.client);
    if (!named && !source) {
      ctx.lines.push(`skipped ${project.key} (not demo data)`);
      continue;
    }
    ctx.projects.set(project.key, { id: row.id, name: row.name });
  }
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
    const branches = await tx
      .insert(projectComponentBranches)
      .values(
        appByKey(project.app).components.map((c) => ({
          projectId,
          componentKey: c.componentKey,
          branch: project.branch,
          updatedAt: addDays(ctx.now, -35),
        }))
      )
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
    const inserted = await tx
      .insert(environments)
      .values(
        DEMO_ENVIRONMENTS.map((e) => ({
          ...e,
          projectId,
          appId,
          url: environmentUrl(project, e.slug),
        }))
      )
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
