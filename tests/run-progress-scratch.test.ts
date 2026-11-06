import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

// The guarded completeRun / failRun against the local scratch Panel DB
// (provision_scratch in the opsdeck-postgres container, reached through its
// published port with the container's own superuser password, read from the
// container and never printed). The run rows it inserts carry the
// description "pcan_it run guard" and are deleted.
const scratch = process.env.PROVISION_SCRATCH_URL;
if (scratch) {
  const password = encodeURIComponent(
    execFileSync("podman", [
      "exec",
      "opsdeck-postgres",
      "printenv",
      "POSTGRES_PASSWORD",
    ])
      .toString()
      .trim()
  );
  process.env.DATABASE_URL = `postgres://postgres:${password}@127.0.0.1:5432/provision_scratch`;
}

describe.skipIf(!scratch)("guarded run completion on scratch", async () => {
  const { eq, sql } = await import("drizzle-orm");
  const { db } = await import("@/lib/db");
  const { environments, runs } = await import("@/lib/db/schema");
  const { completeRun, failRun } = await import("@/lib/run-progress");
  const DESCRIPTION = "pcan_it run guard";

  async function insertRun(status: "started" | "failed") {
    const [env] = await db
      .select({ id: environments.id })
      .from(environments)
      .limit(1);
    const [row] = await db
      .insert(runs)
      .values({
        environmentId: env?.id as string,
        description: DESCRIPTION,
        status,
        errorMessage: status === "failed" ? "Worker restarted" : null,
        output: "",
        runAt: new Date(),
      })
      .returning({ id: runs.id });
    return row?.id as string;
  }
  const statusOf = async (id: string) =>
    (
      await db
        .select({ status: runs.status, error: runs.errorMessage })
        .from(runs)
        .where(eq(runs.id, id))
    )[0];

  afterAll(async () => {
    await db.delete(runs).where(sql`${runs.description} = ${DESCRIPTION}`);
  });

  it("completion of a non-started run leaves it failed", async () => {
    const id = await insertRun("failed");
    expect(await completeRun(id, { onlyIfStarted: true })).toBe(false);
    expect(await failRun(id, "again", { onlyIfStarted: true })).toBe(false);
    expect(await statusOf(id)).toEqual({
      status: "failed",
      error: "Worker restarted",
    });
  });

  it("a started run still completes", async () => {
    const id = await insertRun("started");
    expect(await completeRun(id, { onlyIfStarted: true })).toBe(true);
    expect((await statusOf(id))?.status).toBe("success");
  });
});
