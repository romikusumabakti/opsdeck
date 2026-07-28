"use server";

import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  getServerSession,
  requireAdmin,
  requireSession,
} from "@/lib/auth-session";
import { db } from "@/lib/db";
import type { SafeEnvironmentWithServers } from "@/lib/db/schema";
import {
  type Environment,
  type EnvironmentListItem,
  environmentAccess,
  environments,
  environmentServices,
  type NewEnvironmentService,
  projects,
} from "@/lib/db/schema";
import { loadSafeProject } from "@/lib/projects";
import { encryptNullable } from "@/lib/secrets";
import type { ProjectInput } from "@/lib/validation";
import {
  projectIdSchema,
  projectInputSchema,
  projectUpdateSchema,
} from "@/lib/validation";

// The form posts one flat payload (db*/backend*/frontend* fields); storage is
// one `environments` row plus one `environment_services` row per role. These
// helpers are the single place that mapping lives.
//
// Secret columns (mssql `sa` password, mock-time API key) are encrypted at rest
// here, mirroring the decrypt boundary in lib/projects#loadEnvironmentWithServers.

type ServiceValues = Omit<NewEnvironmentService, "environmentId">;

function dbServiceValues(d: ProjectInput): ServiceValues {
  return {
    role: "db",
    serverId: d.dbServerId,
    serviceType: d.dbServiceType,
    serviceName: d.dbServiceName,
    dbType: d.dbType,
    dbName: d.dbName,
    dbPassword: encryptNullable(d.dbPassword),
    dbBackupPath: d.dbBackupPath,
  };
}

function backendServiceValues(d: ProjectInput): ServiceValues {
  return {
    role: "backend",
    serverId: d.backendServerId,
    serviceType: d.backendServiceType,
    serviceName: d.backendServiceName,
    mockTimeApiUrl: d.backendMockTimeApiUrl,
    mockTimeApiKey: encryptNullable(d.backendMockTimeApiKey),
  };
}

function frontendServiceValues(d: ProjectInput): ServiceValues {
  return {
    role: "frontend",
    serverId: d.frontendServerId,
    serviceType: d.frontendServiceType,
    serviceName: d.frontendServiceName,
  };
}

// Partial-update variants: only keys actually present in the payload are
// carried over, so an edit that touches one field can't null out the rest.
// `undefined` values are dropped; an explicit null still clears a column.
function pickPresent<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

type ProjectUpdate = Partial<ProjectInput>;

function dbServicePatch(d: ProjectUpdate) {
  return pickPresent({
    serverId: d.dbServerId,
    serviceType: d.dbServiceType,
    serviceName: d.dbServiceName,
    dbType: d.dbType,
    dbName: d.dbName,
    dbPassword: "dbPassword" in d ? encryptNullable(d.dbPassword) : undefined,
    dbBackupPath: d.dbBackupPath,
  });
}

function backendServicePatch(d: ProjectUpdate) {
  return pickPresent({
    serverId: d.backendServerId,
    serviceType: d.backendServiceType,
    serviceName: d.backendServiceName,
    mockTimeApiUrl: d.backendMockTimeApiUrl,
    mockTimeApiKey:
      "backendMockTimeApiKey" in d
        ? encryptNullable(d.backendMockTimeApiKey)
        : undefined,
  });
}

function frontendServicePatch(d: ProjectUpdate) {
  return pickPresent({
    serverId: d.frontendServerId,
    serviceType: d.frontendServiceType,
    serviceName: d.frontendServiceName,
  });
}

type ActionResponse = {
  success: boolean;
  message?: string;
  data?: Environment;
};

/**
 * GET: Fetch all projects (without server details — used for the header
 * picker, sidebar, etc. where only id+name matters).
 */
export async function getProjects(): Promise<EnvironmentListItem[]> {
  const session = await requireSession();
  try {
    // Order by the caller's recency (most-recently-opened first), falling back
    // to name for projects they've never opened. `nulls last` keeps unvisited
    // projects below visited ones instead of Postgres' default nulls-first.
    // Joins the owning project's `key` so consumers can build readable URLs
    // (/[key]/[slug]/…) without a second query, plus the `db` service's engine
    // and database name — the two service fields list views render, joined here
    // so the grid doesn't fetch services per row.
    return await db
      .select({
        ...getTableColumns(environments),
        key: projects.key,
        dbType: environmentServices.dbType,
        dbName: environmentServices.dbName,
      })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .leftJoin(
        environmentServices,
        and(
          eq(environmentServices.environmentId, environments.id),
          eq(environmentServices.role, "db")
        )
      )
      .leftJoin(
        environmentAccess,
        and(
          eq(environmentAccess.environmentId, environments.id),
          eq(environmentAccess.userId, session.user.id)
        )
      )
      .orderBy(
        sql`${environmentAccess.lastAccessedAt} desc nulls last`,
        asc(environments.name)
      );
  } catch (error) {
    console.error("Failed to fetch projects:", error);
    return [];
  }
}

/**
 * Record that the current user just opened a project, bumping its recency so
 * the header switcher surfaces it first next time. Fire-and-forget: any failure
 * is logged, never thrown, so it can't break a project page render.
 */
export async function recordProjectAccess(projectId: string): Promise<void> {
  const session = await getServerSession();
  if (!session) return;
  try {
    await db
      .insert(environmentAccess)
      .values({ userId: session.user.id, environmentId: projectId })
      .onConflictDoUpdate({
        target: [environmentAccess.userId, environmentAccess.environmentId],
        set: { lastAccessedAt: sql`now()` },
      });
  } catch (error) {
    console.error("Failed to record project access:", error);
  }
}

/**
 * Per-user "recently opened" timestamps (epoch ms) keyed by project id, for the
 * projects grid's "Recently opened" sort. Mirrors the header switcher's MRU but
 * as a map the client can sort by. Missing project = never opened by this user.
 */
export async function getProjectsLastOpened(): Promise<Record<string, number>> {
  const session = await getServerSession();
  if (!session) return {};
  try {
    const rows = await db
      .select({
        projectId: environmentAccess.environmentId,
        lastAccessedAt: environmentAccess.lastAccessedAt,
      })
      .from(environmentAccess)
      .where(eq(environmentAccess.userId, session.user.id));
    const map: Record<string, number> = {};
    for (const r of rows) map[r.projectId] = r.lastAccessedAt.getTime();
    return map;
  } catch (error) {
    console.error("Failed to fetch project open times:", error);
    return {};
  }
}

/**
 * GET: Fetch a single project by ID with its three server relations loaded.
 * Returns a CREDENTIAL-FREE projection — SSH/DB passwords and the mock-time API
 * key are stripped before the data crosses to the client. Actions that need the
 * real credentials re-load them server-side via lib/projects.
 */
export async function getProjectById(
  id: string
): Promise<SafeEnvironmentWithServers | undefined> {
  await requireSession();
  try {
    return (await loadSafeProject(id)) ?? undefined;
  } catch (error) {
    console.error(`Failed to fetch project ${id}:`, error);
    return undefined;
  }
}

/**
 * CREATE: Add a new project. Server FKs (dbServerId, backendServerId,
 * frontendServerId) must already exist — create them via createServer first.
 */
// URL-friendly base slug from an environment name.
function baseSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "env"
  );
}

// A slug unique within the project — append -2, -3, … on collision.
async function uniqueEnvSlug(projectId: string, name: string): Promise<string> {
  const base = baseSlug(name);
  const existing = await db
    .select({ slug: environments.slug })
    .from(environments)
    .where(eq(environments.projectId, projectId));
  const taken = new Set(existing.map((e) => e.slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export async function createProject(data: unknown): Promise<ActionResponse> {
  await requireAdmin();
  const parsed = projectInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid project data" };
  }
  try {
    const input = parsed.data;
    const slug = await uniqueEnvSlug(input.projectId, input.name);
    // One transaction: an environment without its services is unusable, so the
    // four inserts must land together.
    const insertedProject = await db.transaction(async (tx) => {
      const [env] = await tx
        .insert(environments)
        .values({
          projectId: input.projectId,
          name: input.name,
          slug,
          kind: input.kind,
          owner: input.owner,
        })
        .returning();
      await tx.insert(environmentServices).values(
        [
          dbServiceValues(input),
          backendServiceValues(input),
          frontendServiceValues(input),
        ].map((s) => ({ ...s, environmentId: env.id }))
      );
      return env;
    });

    revalidatePath("/projects");
    revalidatePath("/", "layout");

    return {
      success: true,
      message: "Project created successfully",
      data: insertedProject,
    };
  } catch (error) {
    console.error("Failed to create project:", error);
    return { success: false, message: "Failed to create project" };
  }
}

export async function updateProject(
  id: string,
  data: unknown
): Promise<ActionResponse> {
  await requireAdmin();
  if (!projectIdSchema.safeParse(id).success) {
    return { success: false, message: "Invalid project id" };
  }
  const parsed = projectUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid project data" };
  }
  try {
    const input = parsed.data;
    const envPatch = pickPresent({
      projectId: input.projectId,
      name: input.name,
      kind: input.kind,
      owner: input.owner,
    });
    const servicePatches = [
      { role: "db" as const, patch: dbServicePatch(input) },
      { role: "backend" as const, patch: backendServicePatch(input) },
      { role: "frontend" as const, patch: frontendServicePatch(input) },
    ].filter(({ patch }) => Object.keys(patch).length > 0);

    const updatedProject = await db.transaction(async (tx) => {
      // Always re-read the row so a services-only edit still reports "not found"
      // for a bad id; only issue the UPDATE when the env itself changed.
      const [env] = Object.keys(envPatch).length
        ? await tx
            .update(environments)
            .set(envPatch)
            .where(eq(environments.id, id))
            .returning()
        : await tx.select().from(environments).where(eq(environments.id, id));
      if (!env) return undefined;

      for (const { role, patch } of servicePatches) {
        await tx
          .update(environmentServices)
          .set(patch)
          .where(
            and(
              eq(environmentServices.environmentId, id),
              eq(environmentServices.role, role)
            )
          );
      }
      return env;
    });

    if (!updatedProject) {
      return { success: false, message: "Project not found" };
    }

    revalidatePath("/projects");
    revalidatePath(`/projects/${id}`);

    return {
      success: true,
      message: "Project updated successfully",
      data: updatedProject,
    };
  } catch (error) {
    console.error(`Failed to update project ${id}:`, error);
    return { success: false, message: "Failed to update project" };
  }
}

export async function deleteProject(id: string): Promise<ActionResponse> {
  await requireAdmin();
  try {
    await db.delete(environments).where(eq(environments.id, id));
    revalidatePath("/projects");
    revalidatePath("/", "layout");
    return { success: true, message: "Project deleted successfully" };
  } catch (error) {
    console.error(`Failed to delete project ${id}:`, error);
    return { success: false, message: "Failed to delete project" };
  }
}
