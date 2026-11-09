import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { requireSession } from "@/lib/auth-session";
import { requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { instanceBackups, runs, users } from "@/lib/db/schema";
import { environmentName } from "@/lib/environments";
import {
  type InstanceBackupAttention,
  instanceBackupAttention,
} from "@/lib/home/attention";
import { canOrg } from "@/lib/permissions";
import type { ActionResponse } from "@/lib/types";
import { uuidSchema } from "@/lib/validation";

// The attention key is a run kind or, for legacy runs, a description.
const keySchema = z.string().trim().min(1).max(1000);
const runIdsSchema = z.array(z.uuid()).min(1).max(500);

/**
 * Acknowledge every unacknowledged failure of one attention group — global, so
 * it leaves Home for everyone. A later failure brings the group back.
 */
export async function acknowledgeAttentionGroup(
  environmentId: string,
  key: string
): Promise<ActionResponse<{ runIds: string[] }>> {
  if (
    !uuidSchema.safeParse(environmentId).success ||
    !keySchema.safeParse(key).success
  ) {
    return { success: false, message: "Invalid request" };
  }
  const { session } = await requireProjectPermission(
    { environmentId },
    { run: ["acknowledge"] }
  );
  try {
    const acked = await db
      .update(runs)
      .set({ acknowledgedAt: new Date(), acknowledgedById: session.user.id })
      .where(
        and(
          eq(runs.environmentId, environmentId),
          eq(runs.status, "failed"),
          isNull(runs.acknowledgedAt),
          sql`coalesce(${runs.kind}::text, ${runs.description}) = ${key}`
        )
      )
      .returning({ id: runs.id });
    const firstAck = acked[0];
    if (firstAck) {
      await recordActivity({
        actorId: session.user.id,
        action: "run.acknowledged",
        entityType: "run",
        entityId: firstAck.id,
        data: {
          environment: (await environmentName(environmentId)) ?? "",
          key,
          count: acked.length,
        },
      });
    }
    return { success: true, data: { runIds: acked.map((r) => r.id) } };
  } catch (error) {
    console.error("Failed to acknowledge runs:", error);
    return { success: false, message: "Failed to acknowledge" };
  }
}

/** Undo for the acknowledge toast: only the caller's own acknowledgements. */
export async function unacknowledgeRuns(
  environmentId: string,
  runIds: string[]
): Promise<ActionResponse> {
  if (
    !uuidSchema.safeParse(environmentId).success ||
    !runIdsSchema.safeParse(runIds).success
  ) {
    return { success: false, message: "Invalid request" };
  }
  const { session } = await requireProjectPermission(
    { environmentId },
    { run: ["acknowledge"] }
  );
  try {
    const cleared = await db
      .update(runs)
      .set({ acknowledgedAt: null, acknowledgedById: null })
      .where(
        and(
          eq(runs.environmentId, environmentId),
          inArray(runs.id, runIds),
          eq(runs.acknowledgedById, session.user.id)
        )
      )
      .returning({
        id: runs.id,
        key: sql<string>`coalesce(${runs.kind}::text, ${runs.description})`,
      });
    const firstClr = cleared[0];
    if (firstClr) {
      await recordActivity({
        actorId: session.user.id,
        action: "run.unacknowledged",
        entityType: "run",
        entityId: firstClr.id,
        data: {
          environment: (await environmentName(environmentId)) ?? "",
          key: firstClr.key,
          count: cleared.length,
        },
      });
    }
    return { success: true };
  } catch (error) {
    console.error("Failed to unacknowledge runs:", error);
    return { success: false, message: "Failed to undo" };
  }
}

/**
 * Home's "Needs attention" item for the Panel's own backups, shown to those
 * who manage the instance (null for everyone else): the latest backup failed
 * unacknowledged, or none succeeded in 36 h. The first user's sign-up stands
 * in for the install time, so a fresh install is not flagged at once.
 */
export async function getInstanceBackupAttention(): Promise<InstanceBackupAttention | null> {
  const session = await requireSession();
  if (!canOrg(session.user.role, { instance: ["manage"] })) return null;
  const [[latest], [lastSuccess]] = await Promise.all([
    db
      .select({
        id: instanceBackups.id,
        status: instanceBackups.status,
        errorCode: instanceBackups.errorCode,
        startedAt: instanceBackups.startedAt,
        acknowledgedAt: instanceBackups.acknowledgedAt,
      })
      .from(instanceBackups)
      .where(ne(instanceBackups.status, "running"))
      .orderBy(desc(instanceBackups.startedAt))
      .limit(1),
    db
      .select({ startedAt: instanceBackups.startedAt })
      .from(instanceBackups)
      .where(eq(instanceBackups.status, "succeeded"))
      .orderBy(desc(instanceBackups.startedAt))
      .limit(1),
  ]);
  let installedAt: Date | null = null;
  if (!lastSuccess) {
    const [first] = await db
      .select({ createdAt: users.createdAt })
      .from(users)
      .orderBy(asc(users.createdAt))
      .limit(1);
    installedAt = first?.createdAt ?? null;
  }
  return instanceBackupAttention({
    latest: latest ?? null,
    lastSucceededAt: lastSuccess?.startedAt ?? null,
    installedAt,
    now: new Date(),
  });
}
