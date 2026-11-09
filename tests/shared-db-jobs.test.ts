import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentWithServers } from "@/lib/db/schema";

// The worker re-reads the db service and, for a shared binding, backs up and
// restores as the binding's role: no command connects as postgres and the
// restore never drops or recreates the database, whatever the job payload
// says (including a restore from another environment's backups).

const calls: string[] = [];
// The run each connection was made for.
const runs: unknown[] = [];
vi.mock("@/lib/ssh", () => ({
  executeRemoteCommand: async (creds: { run?: string }, command: string) => {
    calls.push(command);
    runs.push(creds.run);
    return "";
  },
  downloadRemoteFile: async (creds: { run?: string }) => {
    runs.push(creds.run);
  },
  uploadRemoteFile: async (creds: { run?: string }) => {
    runs.push(creds.run);
  },
}));

const server = { host: "db.test", username: "ops", password: "pw" };
const db = (dbKind: string | null, dbName: string) => ({
  role: "db",
  serverId: "s1",
  dbType: "postgres",
  dbName,
  dbRole: dbKind === "shared" ? dbName : null,
  dbKind,
  dbBackupPath: "/var/lib/postgresql/backups",
  serviceType: "docker",
  serviceName: "dplk-postgres",
  server,
});
const TARGET = "01a157bd-38bd-7b91-a3f3-c14d8dfffbd1";
const SOURCE = "01a157bd-38bd-7b91-a3f3-c14d8dfffbd2";
const environments: Record<string, EnvironmentWithServers> = {
  [TARGET]: {
    id: TARGET,
    name: "sandbox",
    services: [db("shared", "pcan_sb")],
  } as unknown as EnvironmentWithServers,
  [SOURCE]: {
    id: SOURCE,
    name: "legacy",
    services: [db(null, "pcan_legacy")],
  } as unknown as EnvironmentWithServers,
};

vi.mock("@/lib/environments", () => ({
  loadEnvironmentWithServers: async (id: string) => environments[id],
}));
vi.mock("@/lib/run-progress", () => ({
  appendRunOutput: async () => {},
  completeRun: async () => {},
  failRun: async () => {},
}));

const { processJob } = await import("@/lib/jobs/processor");
const runId = "01a157b8-794f-7f5c-8a72-59f1cdc6808a";
const job = (name: string, data: Record<string, unknown>) =>
  ({ name, data }) as unknown as Job;

beforeEach(() => {
  calls.length = 0;
  runs.length = 0;
});

describe("shared database jobs run as the binding's role", () => {
  it("backup dumps as the role", async () => {
    await processJob(
      job("db/backup.requested", { environmentId: TARGET, runId })
    );
    const dump = calls.find((c) => c.includes("pg_dump"));
    expect(dump).toContain("pg_dump -U ");
    expect(dump).not.toContain("-U postgres");
    expect(dump).toContain("pcan_sb");
    // A host key first seen here is recorded for system and this run.
    expect(runs.length).toBeGreaterThan(0);
    expect(new Set(runs)).toEqual(new Set([runId]));
  });

  for (const [label, extra] of [
    ["its own backup", {}],
    ["another environment's backup", { sourceEnvironmentId: SOURCE }],
    ["a payload naming another database", { database: "hris_dss" }],
  ] as const) {
    it(`restore of ${label} never connects as postgres nor recreates`, async () => {
      await processJob(
        job("db/restore.requested", {
          environmentId: TARGET,
          filename: "pcan_sb_2026-10-20T05-06-50-923Z.sql.gz",
          runId,
          ...extra,
        })
      );
      const restore = calls.filter((c) => c.includes("psql"));
      expect(restore.length).toBeGreaterThan(0);
      for (const cmd of restore) {
        expect(cmd).not.toContain("-U postgres");
        expect(cmd).not.toMatch(/(DROP|CREATE) DATABASE/);
      }
      expect(restore.join("\n")).toContain("DROP OWNED BY CURRENT_USER");
      // Every connection, the transfer's too, is made for this run.
      expect(new Set(runs)).toEqual(new Set([runId]));
    });
  }

  it("a legacy binding keeps the postgres pipelines", async () => {
    environments[TARGET] = {
      ...environments[TARGET],
      services: [db(null, "pcan_sb")],
    } as unknown as EnvironmentWithServers;
    await processJob(
      job("db/restore.requested", {
        environmentId: TARGET,
        filename: "pcan_sb_1.sql",
        runId,
      })
    );
    expect(calls.join("\n")).toContain("-U postgres");
  });
});
