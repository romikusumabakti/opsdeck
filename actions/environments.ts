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
  environmentServices,
  environments,
  type NewEnvironmentService,
  projects,
} from "@/lib/db/schema";
import { loadSafeEnvironment } from "@/lib/environments";
import { RESERVED_ENV_SLUGS } from "@/lib/reserved-paths";
import { encryptNullable } from "@/lib/secrets";
import type { ActionResponse } from "@/lib/types";
import type { EnvironmentInput } from "@/lib/validation";
import {
  environmentInputSchema,
  environmentUpdateSchema,
  uuidSchema,
} from "@/lib/validation";

// The form posts one flat payload (db*/backend*/frontend* fields); storage is
// one `environments` row plus one `environment_services` row per role. These
// helpers are the single place that mapping lives.
//
// Secret columns (mssql `sa` password, mock-time API key) are encrypted at rest
// here, mirroring the decrypt boundary in
// lib/environments#loadEnvironmentWithServers.

type ServiceValues = Omit<NewEnvironmentService, "environmentId">;

function dbServiceValues(d: EnvironmentInput): ServiceValues {
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

function backendServiceValues(d: EnvironmentInput): ServiceValues {
  return {
    role: "backend",
    serverId: d.backendServerId,
    serviceType: d.backendServiceType,
    serviceName: d.backendServiceName,
    mockTimeApiUrl: d.backendMockTimeApiUrl,
    mockTimeApiKey: encryptNullable(d.backendMockTimeApiKey),
  };
}

function frontendServiceValues(d: EnvironmentInput): ServiceValues {
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

type EnvironmentUpdate = Partial<EnvironmentInput>;

function dbServicePatch(d: EnvironmentUpdate) {
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

function backendServicePatch(d: EnvironmentUpdate) {
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

function frontendServicePatch(d: EnvironmentUpdate) {
  return pickPresent({
    serverId: d.frontendServerId,
    serviceType: d.frontendServiceType,
    serviceName: d.frontendServiceName,
  });
}

/**
 * GET: Fetch every environment (without server details — used for the header
 * picker, sidebar, etc. where only id+name matters).
 */
export async function listEnvironments(): Promise<EnvironmentListItem[]> {
  const session = await requireSession();
  try {
    // Order by the caller's recency (most-recently-opened first), falling back
    // to name for environments they've never opened. `nulls last` keeps unvisited
    // environments below visited ones instead of Postgres' default nulls-first.
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
    console.error("Failed to fetch environments:", error);
    return [];
  }
}

/**
 * Record that the current user just opened an environment, bumping its recency
 * so the header switcher surfaces it first next time. Fire-and-forget: any
 * failure is logged, never thrown, so it can't break an environment page render.
 */
export async function recordEnvironmentAccess(
  environmentId: string
): Promise<void> {
  const session = await getServerSession();
  if (!session) return;
  try {
    await db
      .insert(environmentAccess)
      .values({ userId: session.user.id, environmentId })
      .onConflictDoUpdate({
        target: [environmentAccess.userId, environmentAccess.environmentId],
        set: { lastAccessedAt: sql`now()` },
      });
  } catch (error) {
    console.error("Failed to record environment access:", error);
  }
}

/**
 * Per-user "recently opened" timestamps (epoch ms) keyed by environment id, for
 * the environment list's "Recently opened" sort. Mirrors the header switcher's
 * MRU but as a map the client can sort by. Missing entry = never opened by this
 * user.
 */
export async function getEnvironmentsLastOpened(): Promise<
  Record<string, number>
> {
  const session = await getServerSession();
  if (!session) return {};
  try {
    const rows = await db
      .select({
        environmentId: environmentAccess.environmentId,
        lastAccessedAt: environmentAccess.lastAccessedAt,
      })
      .from(environmentAccess)
      .where(eq(environmentAccess.userId, session.user.id));
    const map: Record<string, number> = {};
    for (const r of rows) map[r.environmentId] = r.lastAccessedAt.getTime();
    return map;
  } catch (error) {
    console.error("Failed to fetch environment open times:", error);
    return {};
  }
}

/**
 * GET: Fetch a single environment by ID with its three server relations loaded.
 * Returns a CREDENTIAL-FREE projection — SSH/DB passwords and the mock-time API
 * key are stripped before the data crosses to the client. Actions that need the
 * real credentials re-load them server-side via lib/environments.
 */
export async function getEnvironmentById(
  id: string
): Promise<SafeEnvironmentWithServers | undefined> {
  await requireSession();
  try {
    return (await loadSafeEnvironment(id)) ?? undefined;
  } catch (error) {
    console.error(`Failed to fetch environment ${id}:`, error);
    return undefined;
  }
}

/**
 * CREATE: Add a new environment. Server FKs (dbServerId, backendServerId,
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

// A slug unique within the project — append -2, -3, … on collision. Slugs that
// would shadow one of the project's own sub-routes are treated as taken, so an
// environment named "Issues" becomes `issues-2` instead of an unreachable page.
async function uniqueEnvSlug(projectId: string, name: string): Promise<string> {
  const base = baseSlug(name);
  const existing = await db
    .select({ slug: environments.slug })
    .from(environments)
    .where(eq(environments.projectId, projectId));
  const taken = new Set([
    ...existing.map((e) => e.slug),
    ...RESERVED_ENV_SLUGS,
  ]);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export async function createEnvironment(
  data: unknown
): Promise<ActionResponse<Environment>> {
  await requireAdmin();
  const parsed = environmentInputSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid environment data" };
  }
  try {
    const input = parsed.data;
    const slug = await uniqueEnvSlug(input.projectId, input.name);
    // One transaction: an environment without its services is unusable, so the
    // four inserts must land together.
    const insertedEnvironment = await db.transaction(async (tx) => {
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
      await tx
        .insert(environmentServices)
        .values(
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
      message: "Environment created successfully",
      data: insertedEnvironment,
    };
  } catch (error) {
    console.error("Failed to create environment:", error);
    return { success: false, message: "Failed to create environment" };
  }
}

export async function updateEnvironment(
  id: string,
  data: unknown
): Promise<ActionResponse<Environment>> {
  await requireAdmin();
  if (!uuidSchema.safeParse(id).success) {
    return { success: false, message: "Invalid environment id" };
  }
  const parsed = environmentUpdateSchema.safeParse(data);
  if (!parsed.success) {
    return { success: false, message: "Invalid environment data" };
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

    const updatedEnvironment = await db.transaction(async (tx) => {
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

    if (!updatedEnvironment) {
      return { success: false, message: "Environment not found" };
    }

    revalidatePath("/projects");
    // An edit can move the environment to another project or rename it, which
    // changes its readable URL — revalidate the whole tree rather than guessing
    // the old /[projectKey]/[envSlug] path.
    revalidatePath("/", "layout");

    return {
      success: true,
      message: "Environment updated successfully",
      data: updatedEnvironment,
    };
  } catch (error) {
    console.error(`Failed to update environment ${id}:`, error);
    return { success: false, message: "Failed to update environment" };
  }
}

export async function deleteEnvironment(id: string): Promise<ActionResponse> {
  await requireAdmin();
  try {
    await db.delete(environments).where(eq(environments.id, id));
    revalidatePath("/projects");
    revalidatePath("/", "layout");
    return { success: true, message: "Environment deleted successfully" };
  } catch (error) {
    console.error(`Failed to delete environment ${id}:`, error);
    return { success: false, message: "Failed to delete environment" };
  }
}
