import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Job } from "bullmq";
import type { EnvironmentWithServers } from "@/lib/db/schema";

// Every remote command the worker issues, with the wall-clock bound it passed.
const calls: { command: string; timeoutMs: number | undefined }[] = [];

mock.module("@/lib/ssh", () => ({
  executeRemoteCommand: async (
    _creds: unknown,
    command: string,
    timeoutMs?: number
  ) => {
    calls.push({ command, timeoutMs });
    return "";
  },
  downloadRemoteFile: async () => {},
  uploadRemoteFile: async () => {},
}));

const environment = {
  id: "01a157bd-38bd-7b91-a3f3-c14d8dfffbda",
  name: "dev",
  services: [
    {
      role: "db",
      dbType: "postgres",
      dbName: "app",
      dbBackupPath: "/var/backups",
      serviceType: "docker",
      serviceName: "pg",
      server: { host: "db.test", username: "ops", password: "pw" },
    },
  ],
} as unknown as EnvironmentWithServers;

mock.module("@/lib/environments", () => ({
  loadEnvironmentWithServers: async () => environment,
}));
mock.module("@/lib/run-progress", () => ({
  appendRunOutput: async () => {},
  completeRun: async () => {},
  failRun: async () => {},
}));

const { processJob } = await import("@/lib/jobs/processor");

const runId = "01a157b8-794f-7f5c-8a72-59f1cdc6808a";

function job(name: string, data: Record<string, unknown>): Job {
  return { name, data } as unknown as Job;
}

// A dump of a real database takes far longer than the 10s default that keeps
// page renders snappy. Restores of an ~20s dump failed with "SSH command timed
// out after 10000ms" once the load step alone crossed 10s.
const MIN_DATA_TIMEOUT_MS = 10 * 60_000;

describe("worker data commands are not bound by the page-render timeout", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("restore: recreate and load both get the long bound", async () => {
    await processJob(
      job("db/restore.requested", {
        environmentId: environment.id,
        filename: "app_2026-10-20T05-06-50-923Z.sql.gz",
        runId,
      })
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.timeoutMs).toBeGreaterThanOrEqual(MIN_DATA_TIMEOUT_MS);
    }
  });

  it("backup: the dump gets the long bound", async () => {
    await processJob(
      job("db/backup.requested", { environmentId: environment.id, runId })
    );
    const dump = calls.find((c) => c.command.includes("pg_dump"));
    expect(dump?.timeoutMs).toBeGreaterThanOrEqual(MIN_DATA_TIMEOUT_MS);
  });
});
