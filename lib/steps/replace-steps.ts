import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { provisioningSteps, teardownSteps } from "@/lib/db/schema";
import { matchDoneSteps } from "@/lib/provisioning/plan";

/** A table of an environment's ordered steps (provisioning, teardown). */
type StepTable = typeof provisioningSteps | typeof teardownSteps;

type StepSpec<T extends StepTable> = {
  kind: T["$inferInsert"]["kind"];
  params: Record<string, unknown>;
};

/**
 * Replaces the environment's steps in `table` with `specs`, in order. Every
 * non-`done` step is dropped and re-created; a `done` step whose kind and
 * params equal a spec is kept (moved to the spec's position), so a re-plan
 * keeps finished work.
 */
export async function replaceSteps<T extends StepTable>(
  table: T,
  environmentId: string,
  specs: StepSpec<T>[]
): Promise<void> {
  // One table type for the queries: both tables share these columns.
  const t = table as typeof provisioningSteps;
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(t)
      .where(eq(t.environmentId, environmentId));
    const keepIds = matchDoneSteps(existing, specs);
    const kept = new Set(keepIds.filter((id): id is string => id !== null));
    const dropIds = existing.filter((s) => !kept.has(s.id)).map((s) => s.id);
    if (dropIds.length > 0) {
      await tx.delete(t).where(inArray(t.id, dropIds));
    }
    if (kept.size > 0) {
      // Two phases: park kept rows on negative positions so moving one never
      // collides with another's old position on the unique index.
      await tx
        .update(t)
        .set({ position: sql`-1 - ${t.position}` })
        .where(inArray(t.id, [...kept]));
    }
    for (const [position, spec] of specs.entries()) {
      const keepId = keepIds[position];
      if (keepId) {
        await tx.update(t).set({ position }).where(eq(t.id, keepId));
      } else {
        await tx.insert(t).values({
          environmentId,
          position,
          kind: spec.kind as (typeof provisioningSteps.$inferInsert)["kind"],
          params: spec.params,
        });
      }
    }
  });
}
