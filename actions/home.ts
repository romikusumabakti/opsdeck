"use server";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { recordActivity } from "@/lib/activity";
import { requireProjectPermission } from "@/lib/authz";
import { db } from "@/lib/db";
import { environments, runs } from "@/lib/db/schema";
import type { ActionResponse } from "@/lib/types";
import { uuidSchema } from "@/lib/validation";

// The attention key is a run kind or, for legacy runs, a description.
const keySchema = z.string().trim().min(1).max(1000);
const runIdsSchema = z.array(z.uuid()).min(1).max(500);

async function environmentName(environmentId: string): Promise<string> {
  const [row] = await db
    .select({ name: environments.name })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  return row?.name ?? "";
}

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
          environment: await environmentName(environmentId),
          key,
          count: acked.length,
        },
      });
    }
    revalidatePath("/[locale]", "page");
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
          environment: await environmentName(environmentId),
          key: firstClr.key,
          count: cleared.length,
        },
      });
    }
    revalidatePath("/[locale]", "page");
    return { success: true };
  } catch (error) {
    console.error("Failed to unacknowledge runs:", error);
    return { success: false, message: "Failed to undo" };
  }
}
