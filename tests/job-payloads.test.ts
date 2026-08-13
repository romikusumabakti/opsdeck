import { describe, expect, it } from "bun:test";
import { parseJobPayload } from "@/lib/jobs/payloads";

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789ab";
const RUN_ID = "0197f3a0-1b2c-7def-8000-0123456789ac";

describe("parseJobPayload", () => {
  it("accepts a well-formed backup payload", () => {
    expect(
      parseJobPayload("db/backup.requested", {
        environmentId: ENV_ID,
        runId: RUN_ID,
        compress: true,
        database: "opsdeck",
      })
    ).toEqual({
      environmentId: ENV_ID,
      runId: RUN_ID,
      compress: true,
      database: "opsdeck",
    });
  });

  it("strips keys the contract doesn't declare", () => {
    const parsed = parseJobPayload("db/database.drop.requested", {
      environmentId: ENV_ID,
      runId: RUN_ID,
      database: "scratch",
      leftoverFromOldProducer: "ignored",
    });
    expect(parsed).toEqual({
      environmentId: ENV_ID,
      runId: RUN_ID,
      database: "scratch",
    });
    expect(parsed).not.toHaveProperty("leftoverFromOldProducer");
  });

  it("names the job in the error so a failed job is diagnosable", () => {
    expect(() =>
      parseJobPayload("db/backup.requested", { environmentId: ENV_ID })
    ).toThrow(/db\/backup\.requested/);
  });

  // The handlers interpolate these into `psql <`, `DROP DATABASE` and
  // `ALTER DATABASE ... MODIFY NAME`. A job can outlive the release that
  // enqueued it, so the worker must not assume the producer validated anything.
  describe("rejects values that would reach a shell or SQL identifier", () => {
    it("a database name carrying shell metacharacters", () => {
      expect(() =>
        parseJobPayload("db/database.drop.requested", {
          environmentId: ENV_ID,
          runId: RUN_ID,
          database: "app; DROP DATABASE prod",
        })
      ).toThrow();
    });

    it("a database name carrying a path separator", () => {
      expect(() =>
        parseJobPayload("db/database.create.requested", {
          environmentId: ENV_ID,
          runId: RUN_ID,
          database: "../../etc/passwd",
        })
      ).toThrow();
    });

    it("a rename target that is not a plain identifier", () => {
      expect(() =>
        parseJobPayload("db/database.rename.requested", {
          environmentId: ENV_ID,
          runId: RUN_ID,
          from: "old",
          to: "new]; DROP DATABASE [prod",
        })
      ).toThrow();
    });

    it("a backup filename that escapes the backup directory", () => {
      expect(() =>
        parseJobPayload("db/restore.requested", {
          environmentId: ENV_ID,
          runId: RUN_ID,
          filename: "../../../etc/shadow.sql",
        })
      ).toThrow();
    });

    it("a backup filename with a non-backup extension", () => {
      expect(() =>
        parseJobPayload("db/restore.requested", {
          environmentId: ENV_ID,
          runId: RUN_ID,
          filename: "payload.sh",
        })
      ).toThrow();
    });

    it("an environment id that is not a uuid", () => {
      expect(() =>
        parseJobPayload("service/control.requested", {
          environmentId: "not-a-uuid",
          runId: RUN_ID,
          role: "backend",
          action: "restart",
        })
      ).toThrow();
    });

    it("a service action outside the known set", () => {
      expect(() =>
        parseJobPayload("service/control.requested", {
          environmentId: ENV_ID,
          runId: RUN_ID,
          role: "backend",
          action: "rm -rf",
        })
      ).toThrow();
    });
  });

  it("accepts the configured database name on backup without the strict rule", () => {
    // An operator-entered dbName may predate databaseNameSchema; backup must
    // still run for those environments (see the comment in payloads.ts).
    expect(
      parseJobPayload("db/backup.requested", {
        environmentId: ENV_ID,
        runId: RUN_ID,
        database: "legacy db name",
      }).database
    ).toBe("legacy db name");
  });

  it("keeps projectId meaning the logical project for jira jobs", () => {
    expect(
      parseJobPayload("jira/sync.project", { projectId: ENV_ID, full: true })
    ).toEqual({ projectId: ENV_ID, full: true });
  });

  it("rejects an unknown push field", () => {
    expect(() =>
      parseJobPayload("jira/push.issue", {
        issueId: ENV_ID,
        fields: ["title", "reporter"],
      })
    ).toThrow();
  });

  it("requires an offset on the legacy mock-time instant", () => {
    expect(() =>
      parseJobPayload("environment/mock-time.legacy", {
        environmentId: ENV_ID,
        runId: RUN_ID,
        mockedAt: "2026-08-13 10:00:00",
      })
    ).toThrow();
    expect(
      parseJobPayload("environment/mock-time.legacy", {
        environmentId: ENV_ID,
        runId: RUN_ID,
        mockedAt: "2026-08-13T10:00:00+07:00",
      }).mockedAt
    ).toBe("2026-08-13T10:00:00+07:00");
  });
});
