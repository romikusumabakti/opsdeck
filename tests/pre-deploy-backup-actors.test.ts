import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

const { preDeployBackupActors } = await import("@/lib/deploy/repository");

// The backfill's pairing of a pre-deploy backup run with its deploy run. The
// deploy run is created when the deployment is queued and the backup run only
// when the worker runs it, so the deploy run is the one at or BEFORE the
// backup; the one whose log names the backup run wins.
describe("preDeployBackupActors", () => {
  const { sql, params } = preDeployBackupActors.toSQL();

  it("lists backup runs without an actor, by their description prefix", () => {
    expect(sql).toMatch(/from "runs" "backup_run"/);
    expect(sql).toContain(`"backup_run"."kind" = $`);
    expect(sql).toContain(`"backup_run"."description" like $`);
    expect(params).toContain("Pre-deploy backup for %");
    expect(sql).toContain(`"backup_run"."user_id" is null`);
    expect(sql).toContain(`"backup_run"."triggered_by" is null`);
  });

  it("joins at most one deploy run of the same environment and subject", () => {
    expect(sql).toMatch(
      /left join lateral \(select .* from "runs" "deploy_run"/
    );
    expect(sql).toContain(
      `"deploy_run"."environment_id" = "backup_run"."environment_id"`
    );
    expect(sql).toContain(`"deploy_run"."kind" = $`);
    for (const trigger of ["auto", "manual", "rollback"]) {
      expect(params).toContain(` (${trigger})`);
    }
    expect(sql).toContain(`"deploy_run"."run_at" <= "backup_run"."run_at"`);
    expect(sql).toMatch(
      /order by strpos\("deploy_run"."output", .*"backup_run"."id".*\) > 0 desc, "deploy_run"."run_at" desc, "deploy_run"."id" desc limit \$\d+\) "source_run" on true/
    );
  });
});
