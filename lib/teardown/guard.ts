import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { runs, teardownSteps } from "@/lib/db/schema";
import { type CreateRunInput, insertRun } from "@/lib/run-progress";

// What keeps other work off an environment that is being deleted. Once a
// teardown run is started, or a teardown step is running or done, a deploy
// (manual, auto, or released from the deploy lock), a provisioning run, a
// backup or a restore would act on a stack the teardown is taking apart:
// bring it back up after stack_down, create objects no step removes. Steps
// that are only pending, or failed with none done, are still re-plannable
// and do not block. Cancelling a teardown (cancelTeardownSteps, only while
// just checks, archives and the stop are done) deletes its steps, which
// lifts the block.
//
// Atomic with startTeardownRun: it holds the transaction-scoped advisory
// lock on the environment id exclusively; the paths here hold the same key
// shared (holdEnvironmentShared) before their own checks, so they never
// interleave with a teardown start but not with each other.

type Executor = Pick<typeof db, "select">;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The advisory lock key of an environment (provisioning, teardown, deploys). */
export function environmentLockKey(environmentId: string) {
  return sql`hashtextextended(${environmentId}::text, 0)`;
}

/** Holds the environment's advisory lock shared until the transaction ends. */
export async function holdEnvironmentShared(
  tx: Pick<Tx, "execute">,
  environmentId: string
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(${environmentLockKey(environmentId)})`
  );
}

/** Holds the environment's advisory lock exclusively until the tx ends. */
export async function holdEnvironmentExclusive(
  tx: Pick<Tx, "execute">,
  environmentId: string
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${environmentLockKey(environmentId)})`
  );
}

/**
 * Whether a teardown is under way on the environment: a teardown run is
 * `started`, or a teardown step is `running` or `done`.
 */
export async function teardownBlocks(
  environmentId: string,
  executor: Executor = db
): Promise<boolean> {
  const [step] = await executor
    .select({ id: teardownSteps.id })
    .from(teardownSteps)
    .where(
      and(
        eq(teardownSteps.environmentId, environmentId),
        inArray(teardownSteps.status, ["running", "done"])
      )
    )
    .limit(1);
  if (step) return true;
  const [run] = await executor
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.environmentId, environmentId),
        eq(runs.kind, "teardown"),
        eq(runs.status, "started")
      )
    )
    .limit(1);
  return run !== undefined;
}

/**
 * createRun for work a teardown blocks (a backup, a restore, a database or
 * service operation): under the
 * shared environment lock, null instead of a run while a teardown is under
 * way.
 */
export async function createRunUnlessTearingDown(
  input: CreateRunInput
): Promise<string | null> {
  return db.transaction(async (tx) => {
    await holdEnvironmentShared(tx, input.environmentId);
    if (await teardownBlocks(input.environmentId, tx)) return null;
    return insertRun(tx, input);
  });
}
