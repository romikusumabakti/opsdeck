"use server";

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireAdmin, requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import {
  type JiraConnection,
  type JiraLinkWithConnection,
  jiraConnections,
  jiraProjectLinks,
  type SafeJiraConnection,
} from "@/lib/db/schema";
import { JiraClient, JiraError, normalizeBaseUrl } from "@/lib/jira/client";
import { normalizeOverrides } from "@/lib/jira/mapping";
import { credentialsFor, ENUM_VALUES } from "@/lib/jira/sync";
import { enqueue, scheduleJiraSweep, unscheduleJiraSweep } from "@/lib/queue";
import { decryptSecret, encryptSecret } from "@/lib/secrets";
import {
  jiraConnectionInputSchema,
  jiraConnectionUpdateSchema,
  jiraProjectLinkSchema,
} from "@/lib/validation";

/**
 * Admin management of Jira sites, and per-project linking.
 *
 * Mirrors actions/s3-connections.ts: credentials are encrypted on write and
 * stripped on read, and every mutation is admin-gated. The actual syncing never
 * happens inline — these actions only enqueue, so a slow or rate-limited Jira
 * can't hold a request open.
 */

type SimpleResponse =
  | { success: true; message?: string }
  | { success: false; message: string };

type CreateResponse =
  | { success: true; data: SafeJiraConnection; message?: string }
  | { success: false; message: string };

function toSafe(row: JiraConnection): SafeJiraConnection {
  const { apiToken, webhookSecret, ...rest } = row;
  return { ...rest, hasToken: apiToken.length > 0 };
}

// --- Connections ---

export async function getJiraConnections(): Promise<SafeJiraConnection[]> {
  await requireSession();
  const rows = await db
    .select()
    .from(jiraConnections)
    .orderBy(jiraConnections.name);
  return rows.map(toSafe);
}

export async function getJiraConnection(
  id: string
): Promise<SafeJiraConnection | undefined> {
  await requireSession();
  const [row] = await db
    .select()
    .from(jiraConnections)
    .where(eq(jiraConnections.id, id))
    .limit(1);
  return row ? toSafe(row) : undefined;
}

/**
 * The URL to paste into Jira's admin UI (System → WebHooks).
 *
 * Admin-only, because the path *is* the credential: Jira Cloud's system
 * webhooks cannot sign a request body, so an unguessable path is what
 * authenticates a delivery. See the route for what that does and doesn't buy.
 */
export async function getJiraWebhookUrl(
  connectionId: string
): Promise<string | null> {
  await requireAdmin();
  const [row] = await db
    .select({ webhookSecret: jiraConnections.webhookSecret })
    .from(jiraConnections)
    .where(eq(jiraConnections.id, connectionId))
    .limit(1);
  if (!row) return null;
  // Same env var the auth layer builds its callback URLs from, so the value an
  // admin pastes into Jira matches the origin the app is actually served on.
  const base = normalizeBaseUrl(
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000"
  );
  return `${base}/api/jira/webhook/${row.webhookSecret}`;
}

export async function createJiraConnection(
  data: unknown
): Promise<CreateResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const parsed = jiraConnectionInputSchema.safeParse(data);
  if (!parsed.success) return { success: false, message: t("invalidInput") };

  try {
    const [created] = await db
      .insert(jiraConnections)
      .values({
        name: parsed.data.name,
        baseUrl: normalizeBaseUrl(parsed.data.baseUrl),
        flavor: parsed.data.flavor,
        email:
          parsed.data.flavor === "cloud" ? (parsed.data.email ?? null) : null,
        apiToken: encryptSecret(parsed.data.apiToken),
        // 32 bytes of URL-safe randomness — the shared secret in the webhook
        // path. Generated once and never rotated automatically, since rotating
        // it silently breaks an already-configured Jira webhook.
        webhookSecret: randomBytes(24).toString("base64url"),
      })
      .returning();
    revalidatePath("/admin/jira");
    return { success: true, data: toSafe(created), message: t("jiraCreated") };
  } catch (error) {
    console.error("Failed to create Jira connection:", error);
    return { success: false, message: t("jiraCreateFailed") };
  }
}

export async function updateJiraConnection(
  id: string,
  data: unknown
): Promise<SimpleResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const parsed = jiraConnectionUpdateSchema.safeParse(data);
  if (!parsed.success) return { success: false, message: t("invalidInput") };

  const patch: Record<string, unknown> = {
    ...parsed.data,
    updatedAt: new Date(),
  };
  // Blank/omitted token means "keep the stored one".
  if (parsed.data.apiToken)
    patch.apiToken = encryptSecret(parsed.data.apiToken);
  else delete patch.apiToken;
  if (parsed.data.baseUrl)
    patch.baseUrl = normalizeBaseUrl(parsed.data.baseUrl);
  if (parsed.data.flavor === "datacenter") patch.email = null;

  try {
    const [updated] = await db
      .update(jiraConnections)
      .set(patch)
      .where(eq(jiraConnections.id, id))
      .returning();
    if (!updated) return { success: false, message: t("jiraNotFound") };
    revalidatePath("/admin/jira");
    revalidatePath(`/admin/jira/${id}`);
    return { success: true, message: t("jiraUpdated") };
  } catch (error) {
    console.error(`Failed to update Jira connection ${id}:`, error);
    return { success: false, message: t("jiraUpdateFailed") };
  }
}

export async function deleteJiraConnection(
  id: string
): Promise<SimpleResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  let orphaned: { projectId: string }[] = [];
  try {
    // Links cascade with the connection, so collect them before the delete —
    // their sweep schedules have to be torn down too.
    orphaned = await db
      .select({ projectId: jiraProjectLinks.projectId })
      .from(jiraProjectLinks)
      .where(eq(jiraProjectLinks.connectionId, id));
    await db.delete(jiraConnections).where(eq(jiraConnections.id, id));
  } catch (error) {
    console.error(`Failed to delete Jira connection ${id}:`, error);
    return { success: false, message: t("jiraDeleteFailed") };
  }
  // Best-effort: a scheduler left pointing at a deleted link just runs a sweep
  // that finds nothing and exits.
  for (const link of orphaned) {
    try {
      await unscheduleJiraSweep(link.projectId);
    } catch (error) {
      console.error("Failed to unschedule the Jira sweep:", error);
    }
  }
  revalidatePath("/admin/jira");
  return { success: true, message: t("jiraDeleted") };
}

/**
 * Probe credentials without persisting them. In edit mode the token may be
 * omitted and the stored one is loaded by id — mirrors testS3ConnectionAction.
 */
export async function testJiraConnection(input: {
  baseUrl: string;
  flavor: "cloud" | "datacenter";
  email?: string | null;
  apiToken?: string;
  connectionId?: string;
}): Promise<{ ok: true; account: string } | { ok: false; message: string }> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");

  let token = input.apiToken;
  if (!token && input.connectionId) {
    const [row] = await db
      .select({ apiToken: jiraConnections.apiToken })
      .from(jiraConnections)
      .where(eq(jiraConnections.id, input.connectionId))
      .limit(1);
    if (!row) return { ok: false, message: t("jiraNotFound") };
    token = decryptSecret(row.apiToken);
  }
  if (!token) return { ok: false, message: t("jiraTokenRequiredForTest") };

  try {
    const client = new JiraClient({
      baseUrl: input.baseUrl,
      flavor: input.flavor,
      email: input.email ?? null,
      token,
    });
    const me = await client.getMyself();
    return {
      ok: true,
      account: me.displayName ?? me.emailAddress ?? me.accountId ?? "",
    };
  } catch (error) {
    const message =
      error instanceof JiraError && error.isAuth
        ? t("jiraAuthFailed")
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, message };
  }
}

// --- Project link ---

export async function getJiraLink(
  projectId: string
): Promise<JiraLinkWithConnection | null> {
  await requireSession();
  const [row] = await db
    .select({
      link: jiraProjectLinks,
      connection: {
        id: jiraConnections.id,
        name: jiraConnections.name,
        baseUrl: jiraConnections.baseUrl,
      },
    })
    .from(jiraProjectLinks)
    .innerJoin(
      jiraConnections,
      eq(jiraConnections.id, jiraProjectLinks.connectionId)
    )
    .where(eq(jiraProjectLinks.projectId, projectId))
    .limit(1);
  return row ? { ...row.link, connection: row.connection } : null;
}

/**
 * Create or update a project's Jira link.
 *
 * The remote project key is verified against the API before it is stored — a
 * typo here would otherwise surface fifteen minutes later as an empty sweep
 * with an opaque error. Enabling the link (re)registers the reconcile schedule
 * and kicks off an immediate incremental sweep.
 */
export async function saveJiraLink(data: unknown): Promise<SimpleResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const parsed = jiraProjectLinkSchema.safeParse(data);
  if (!parsed.success) return { success: false, message: t("invalidInput") };
  const input = parsed.data;

  const [connection] = await db
    .select()
    .from(jiraConnections)
    .where(eq(jiraConnections.id, input.connectionId))
    .limit(1);
  if (!connection) return { success: false, message: t("jiraNotFound") };

  try {
    const client = new JiraClient(credentialsFor(connection));
    await client.getProject(input.jiraProjectKey);
  } catch (error) {
    console.error("Jira project key check failed:", error);
    return {
      success: false,
      message:
        error instanceof JiraError && error.status === 404
          ? t("jiraProjectNotFound")
          : t("jiraProjectCheckFailed"),
    };
  }

  const overrides = normalizeOverrides(input.mappingOverrides, ENUM_VALUES);

  try {
    await db
      .insert(jiraProjectLinks)
      .values({
        projectId: input.projectId,
        connectionId: input.connectionId,
        jiraProjectKey: input.jiraProjectKey,
        jqlFilter: input.jqlFilter ?? null,
        enabled: input.enabled,
        pushEnabled: input.pushEnabled,
        mappingOverrides: overrides,
      })
      .onConflictDoUpdate({
        target: jiraProjectLinks.projectId,
        set: {
          connectionId: input.connectionId,
          jiraProjectKey: input.jiraProjectKey,
          jqlFilter: input.jqlFilter ?? null,
          enabled: input.enabled,
          pushEnabled: input.pushEnabled,
          mappingOverrides: overrides,
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    console.error("Failed to save Jira link:", error);
    return { success: false, message: t("jiraLinkSaveFailed") };
  }

  // The link row is already committed, so a Redis hiccup must not report the
  // save as failed. The worker re-registers every enabled link's schedule on
  // boot (see lib/jobs/worker.ts), which is the recovery path.
  try {
    if (input.enabled) {
      await scheduleJiraSweep(input.projectId);
      await enqueueSweep(input.projectId, false);
    } else {
      await unscheduleJiraSweep(input.projectId);
    }
  } catch (error) {
    console.error("Failed to (un)schedule the Jira sweep:", error);
  }
  revalidatePath("/[locale]/[projectKey]/settings", "page");
  return { success: true, message: t("jiraLinkSaved") };
}

/**
 * Unlink. The mirrored issues stay — they are real work items people have
 * commented on and linked to. Only the binding and the `jira*` columns go, so
 * relinking later re-imports cleanly instead of duplicating everything.
 */
export async function unlinkJiraProject(
  projectId: string
): Promise<SimpleResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  try {
    // Row first: it is the source of truth. A sweep that fires against a
    // deleted link finds nothing to do and exits, so a stale scheduler is
    // harmless — whereas a failed unschedule must not block the unlink.
    await db
      .delete(jiraProjectLinks)
      .where(eq(jiraProjectLinks.projectId, projectId));
  } catch (error) {
    console.error(`Failed to unlink Jira for project ${projectId}:`, error);
    return { success: false, message: t("jiraUnlinkFailed") };
  }
  try {
    await unscheduleJiraSweep(projectId);
  } catch (error) {
    console.error("Failed to unschedule the Jira sweep:", error);
  }
  revalidatePath("/[locale]/[projectKey]/settings", "page");
  return { success: true, message: t("jiraUnlinked") };
}

/** "Sync now" — queues a sweep; `full` re-reads the project from scratch. */
export async function syncJiraProjectNow(
  projectId: string,
  full = false
): Promise<SimpleResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const [link] = await db
    .select({ enabled: jiraProjectLinks.enabled })
    .from(jiraProjectLinks)
    .where(eq(jiraProjectLinks.projectId, projectId))
    .limit(1);
  if (!link) return { success: false, message: t("jiraNotLinked") };
  await enqueueSweep(projectId, full);
  return { success: true, message: t("jiraSyncQueued") };
}

/**
 * One sweep per project at a time: `jobId` makes BullMQ drop an add whose id is
 * already queued, so double-clicking "Sync now" or a manual sweep landing on
 * top of the scheduled one collapses into a single run.
 */
async function enqueueSweep(projectId: string, full: boolean): Promise<void> {
  await enqueue(
    "jira/sync.project",
    { projectId, full },
    {
      attempts: 3,
      backoffMs: 5_000,
      jobId: `jira-sync-${projectId}${full ? "-full" : ""}`,
    }
  );
}
