import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";
const DEPLOYMENT_ID = "0197f3a0-1b2c-7def-8000-0123456789d1";
const RELEASE_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const RUN_ID = "0197f3a0-1b2c-7def-8000-0123456789c1";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";

const state = vi.hoisted(() => ({
  role: "engineer" as string,
  orgRole: "admin" as string,
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));

vi.mock("@/lib/authz", async () => {
  const { canOrg, canProject } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    requireProjectPermission: vi.fn(
      async (_scope: unknown, perms: Parameters<typeof canProject>[1]) => {
        if (!canProject(state.role as "viewer", perms)) {
          throw new HTTPException(403, { message: "Forbidden" });
        }
        return {
          session: { user: { id: USER_ID } },
          role: state.role,
          projectId: PROJECT_ID,
        };
      }
    ),
    requireOrgPermission: vi.fn(async (perms: Parameters<typeof canOrg>[1]) => {
      if (!canOrg(state.orgRole, perms)) {
        throw new HTTPException(403, { message: "Forbidden" });
      }
      return { user: { id: USER_ID, role: state.orgRole } };
    }),
  };
});

const repo = vi.hoisted(() => ({
  getReleaseSource: vi.fn(),
  insertReleaseWithRun: vi.fn(),
  getRelease: vi.fn(),
  listProjectReleases: vi.fn(),
  setReleaseNotes: vi.fn(),
  deleteReleaseRow: vi.fn(),
  markReleaseFailed: vi.fn(),
}));
vi.mock("@/lib/releases/repository", () => repo);

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/activity", () => activity);

const queue = vi.hoisted(() => ({ enqueue: vi.fn() }));
vi.mock("@/lib/queue", () => queue);

const progress = vi.hoisted(() => ({
  appendRunOutput: vi.fn(),
  failRun: vi.fn(),
}));
vi.mock("@/lib/run-progress", () => progress);

const store = vi.hoisted(() => ({
  read: vi.fn(),
  delete: vi.fn(),
  upload: vi.fn(),
}));
const garage = vi.hoisted(() => ({ configured: true }));
vi.mock("@/lib/instance-backup/destination", () => ({
  garageSource: () => (garage.configured ? store : null),
}));

const {
  createRelease,
  createReleaseSchema,
  deleteRelease,
  listReleases,
  openReleaseDownload,
  updateReleaseNotes,
  updateReleaseNotesSchema,
} = await import("@/server/services/releases");
const { requireProjectPermission } = await import("@/lib/authz");
const OTHER_PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f2";

const source = {
  deploymentId: DEPLOYMENT_ID,
  environmentId: ENV_ID,
  environmentName: "TMLI SIT",
  projectId: PROJECT_ID,
  projectName: "TMLI",
  status: "success",
  tag: "origin-release-tmli-abc1234",
  componentKey: "legacy-core-backend",
  targetKind: "jar",
  branch: "release/tmli",
  commitSha: "abc1234def",
};

const OBJECT_KEY = `releases/${PROJECT_ID}/legacy-core-backend/${RELEASE_ID}/legacy-core-backend_TMLI-2026-11-2.jar`;

const readyRelease = {
  id: RELEASE_ID,
  projectId: PROJECT_ID,
  projectName: "TMLI",
  componentKey: "legacy-core-backend",
  environmentId: ENV_ID,
  environmentName: "TMLI SIT",
  deploymentId: DEPLOYMENT_ID,
  branch: "release/tmli",
  tag: "origin-release-tmli-abc1234",
  commitSha: "abc1234def",
  version: "TMLI 2026-11-2",
  notes: null,
  status: "ready",
  error: null,
  objectKey: OBJECT_KEY,
  fileName: "legacy-core-backend_TMLI-2026-11-2.jar",
  sizeBytes: 1234,
  sha256: "a".repeat(64),
  createdBy: USER_ID,
  createdAt: new Date("2026-11-11T05:00:00Z"),
  readyAt: new Date("2026-11-11T05:01:00Z"),
};

function uniqueViolation() {
  return Object.assign(new Error("duplicate key"), { code: "23505" });
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { status?: number; code?: string; message: string };
  }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  vi.clearAllMocks();
  state.role = "engineer";
  state.orgRole = "admin";
  garage.configured = true;
  repo.getReleaseSource.mockResolvedValue(source);
  repo.insertReleaseWithRun.mockResolvedValue({
    releaseId: RELEASE_ID,
    runId: RUN_ID,
  });
  repo.getRelease.mockResolvedValue(readyRelease);
  queue.enqueue.mockResolvedValue(undefined);
  repo.deleteReleaseRow.mockResolvedValue({ objectKey: null });
});

describe("release input schemas", () => {
  const base = { deploymentId: DEPLOYMENT_ID };

  it("trims the version and accepts 1–100 characters", () => {
    expect(
      createReleaseSchema.parse({ ...base, version: "  TMLI 2026-11-2 " })
        .version
    ).toBe("TMLI 2026-11-2");
    expect(
      createReleaseSchema.safeParse({ ...base, version: "x".repeat(100) })
        .success
    ).toBe(true);
    expect(
      createReleaseSchema.safeParse({ ...base, version: "x".repeat(101) })
        .success
    ).toBe(false);
    expect(
      createReleaseSchema.safeParse({ ...base, version: "   " }).success
    ).toBe(false);
  });

  it("refuses control characters in the version", () => {
    for (const version of ["a\nb", "a\u0000b", "a\tb", "a\u009fb"]) {
      expect(
        createReleaseSchema.safeParse({ ...base, version }).success,
        JSON.stringify(version)
      ).toBe(false);
    }
  });

  it("allows notes up to 2000 characters and stores blank notes as null", () => {
    expect(
      createReleaseSchema.safeParse({
        ...base,
        version: "v1",
        notes: "n".repeat(2000),
      }).success
    ).toBe(true);
    expect(
      createReleaseSchema.safeParse({
        ...base,
        version: "v1",
        notes: "n".repeat(2001),
      }).success
    ).toBe(false);
    expect(updateReleaseNotesSchema.parse({ notes: "  " }).notes).toBeNull();
    expect(updateReleaseNotesSchema.parse({ notes: null }).notes).toBeNull();
  });

  it("is strict", () => {
    expect(
      createReleaseSchema.safeParse({ ...base, version: "v1", tag: "x" })
        .success
    ).toBe(false);
    expect(updateReleaseNotesSchema.safeParse({}).success).toBe(false);
  });
});

describe("createRelease", () => {
  const input = {
    deploymentId: DEPLOYMENT_ID,
    version: "TMLI 2026-11-2",
    notes: "First November drop",
  };

  it("records a preparing release from a successful jar deployment and queues its job", async () => {
    await expect(createRelease(ENV_ID, input)).resolves.toEqual({
      releaseId: RELEASE_ID,
      runId: RUN_ID,
    });
    expect(repo.insertReleaseWithRun).toHaveBeenCalledWith(
      {
        projectId: PROJECT_ID,
        componentKey: "legacy-core-backend",
        environmentId: ENV_ID,
        environmentName: "TMLI SIT",
        deploymentId: DEPLOYMENT_ID,
        branch: "release/tmli",
        tag: "origin-release-tmli-abc1234",
        commitSha: "abc1234def",
        version: "TMLI 2026-11-2",
        notes: "First November drop",
        createdBy: USER_ID,
      },
      expect.objectContaining({
        environmentId: ENV_ID,
        userId: USER_ID,
        kind: "release",
      })
    );
    expect(queue.enqueue).toHaveBeenCalledWith("release/prepare.requested", {
      releaseId: RELEASE_ID,
      runId: RUN_ID,
    });
    expect(activity.recordActivity).toHaveBeenCalledWith({
      actorId: USER_ID,
      action: "release.created",
      entityType: "project",
      entityId: PROJECT_ID,
      data: {
        project: "TMLI",
        component: "legacy-core-backend",
        version: "TMLI 2026-11-2",
      },
    });
  });

  it("accepts a static target too", async () => {
    repo.getReleaseSource.mockResolvedValue({
      ...source,
      targetKind: "static",
    });
    await expect(createRelease(ENV_ID, input)).resolves.toEqual({
      releaseId: RELEASE_ID,
      runId: RUN_ID,
    });
  });

  it("refuses a deployment that did not succeed with 409, and records nothing", async () => {
    repo.getReleaseSource.mockResolvedValue({ ...source, status: "failed" });
    const error = await rejection(createRelease(ENV_ID, input));
    expect(error).toMatchObject({ status: 409, code: "releaseSourceInvalid" });
    expect(repo.insertReleaseWithRun).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("refuses a compose target with 400", async () => {
    repo.getReleaseSource.mockResolvedValue({
      ...source,
      targetKind: "compose",
    });
    const error = await rejection(createRelease(ENV_ID, input));
    expect(error).toMatchObject({ status: 400, code: "releaseSourceInvalid" });
    expect(repo.insertReleaseWithRun).not.toHaveBeenCalled();
  });

  it("refuses a deployment of another environment, or none, with 409", async () => {
    repo.getReleaseSource.mockResolvedValue({
      ...source,
      environmentId: "0197f3a0-1b2c-7def-8000-0123456789e2",
    });
    expect(await rejection(createRelease(ENV_ID, input))).toMatchObject({
      status: 409,
      code: "releaseSourceInvalid",
    });
    repo.getReleaseSource.mockResolvedValue(null);
    expect(await rejection(createRelease(ENV_ID, input))).toMatchObject({
      status: 409,
      code: "releaseSourceInvalid",
    });
    expect(repo.insertReleaseWithRun).not.toHaveBeenCalled();
  });

  it("refuses a deployed tag the Panel has no build for with 409", async () => {
    repo.getReleaseSource.mockResolvedValue({
      ...source,
      branch: null,
      commitSha: null,
    });
    expect(await rejection(createRelease(ENV_ID, input))).toMatchObject({
      status: 409,
      code: "releaseSourceInvalid",
    });
  });

  it("is forbidden for QA and viewers", async () => {
    for (const role of ["qa", "viewer"]) {
      state.role = role;
      expect(await rejection(createRelease(ENV_ID, input))).toMatchObject({
        status: 403,
      });
    }
    expect(repo.getReleaseSource).not.toHaveBeenCalled();
    expect(repo.insertReleaseWithRun).not.toHaveBeenCalled();
  });

  it("answers a version already in use with 409 releaseVersionTaken", async () => {
    repo.insertReleaseWithRun.mockRejectedValueOnce(uniqueViolation());
    expect(await rejection(createRelease(ENV_ID, input))).toMatchObject({
      status: 409,
      code: "releaseVersionTaken",
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("allows the version again once the earlier release failed (the index skips failed rows)", async () => {
    // The partial unique index excludes failed releases, so the insert of
    // the same version succeeds; the service adds no check of its own.
    repo.insertReleaseWithRun.mockRejectedValueOnce(uniqueViolation());
    await rejection(createRelease(ENV_ID, input));
    await expect(createRelease(ENV_ID, input)).resolves.toEqual({
      releaseId: RELEASE_ID,
      runId: RUN_ID,
    });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("fails the release and its run when the job cannot be queued", async () => {
    queue.enqueue.mockRejectedValueOnce(new Error("redis down"));
    await expect(createRelease(ENV_ID, input)).rejects.toThrow("redis down");
    expect(repo.markReleaseFailed).toHaveBeenCalledWith(
      RELEASE_ID,
      "Preparing the release could not be queued"
    );
    expect(progress.failRun).toHaveBeenCalledWith(
      RUN_ID,
      "Preparing the release could not be queued"
    );
  });
});

describe("listReleases", () => {
  it("returns the rows and their total size to anyone who may view deploys", async () => {
    const rows = [
      { ...readyRelease, createdByName: "Romi" },
      {
        ...readyRelease,
        id: "0197f3a0-1b2c-7def-8000-0123456789a2",
        status: "preparing",
        sizeBytes: null,
        createdByName: null,
      },
      { ...readyRelease, sizeBytes: 66, createdByName: "Romi" },
    ];
    repo.listProjectReleases.mockResolvedValue(rows);
    state.role = "qa";
    await expect(listReleases(PROJECT_ID)).resolves.toEqual({
      releases: rows,
      totalBytes: 1300,
    });
    expect(repo.listProjectReleases).toHaveBeenCalledWith(PROJECT_ID);
  });
});

describe("updateReleaseNotes", () => {
  it("changes the notes for an engineer", async () => {
    repo.setReleaseNotes.mockResolvedValue({ ...readyRelease, notes: "x" });
    await expect(updateReleaseNotes(RELEASE_ID, "x")).resolves.toMatchObject({
      notes: "x",
    });
    expect(repo.setReleaseNotes).toHaveBeenCalledWith(RELEASE_ID, "x");
  });

  it("is forbidden for QA", async () => {
    state.role = "qa";
    expect(await rejection(updateReleaseNotes(RELEASE_ID, "x"))).toMatchObject({
      status: 403,
    });
    expect(repo.setReleaseNotes).not.toHaveBeenCalled();
  });

  it("is 404 for an unknown or malformed id", async () => {
    repo.getRelease.mockResolvedValue(null);
    expect(await rejection(updateReleaseNotes(RELEASE_ID, "x"))).toMatchObject({
      status: 404,
    });
    expect(await rejection(updateReleaseNotes("nope", "x"))).toMatchObject({
      status: 404,
    });
  });
});

describe("deleteRelease", () => {
  it("is forbidden without org server:manage", async () => {
    state.orgRole = "member";
    expect(await rejection(deleteRelease(RELEASE_ID))).toMatchObject({
      status: 403,
    });
    expect(store.delete).not.toHaveBeenCalled();
    expect(repo.deleteReleaseRow).not.toHaveBeenCalled();
  });

  it("deletes the stored file, then the row, and logs it", async () => {
    const order: string[] = [];
    store.delete.mockImplementation(async () => {
      order.push("object");
    });
    repo.deleteReleaseRow.mockImplementation(async () => {
      order.push("row");
      return { objectKey: OBJECT_KEY };
    });
    await deleteRelease(RELEASE_ID);
    expect(store.delete).toHaveBeenCalledWith([OBJECT_KEY]);
    expect(repo.deleteReleaseRow).toHaveBeenCalledWith(RELEASE_ID);
    expect(order).toEqual(["object", "row"]);
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: USER_ID,
        action: "release.deleted",
        data: {
          project: "TMLI",
          component: "legacy-core-backend",
          version: "TMLI 2026-11-2",
        },
      })
    );
  });

  it("deletes a release that has no file without touching storage", async () => {
    repo.getRelease.mockResolvedValue({
      ...readyRelease,
      status: "failed",
      objectKey: null,
    });
    garage.configured = false;
    await deleteRelease(RELEASE_ID);
    expect(store.delete).not.toHaveBeenCalled();
    expect(repo.deleteReleaseRow).toHaveBeenCalledWith(RELEASE_ID);
  });

  it("keeps the row when the stored file cannot be deleted", async () => {
    store.delete.mockRejectedValueOnce(new Error("garage down"));
    await expect(deleteRelease(RELEASE_ID)).rejects.toThrow("garage down");
    expect(repo.deleteReleaseRow).not.toHaveBeenCalled();
  });

  it("is 404 for an unknown release", async () => {
    repo.getRelease.mockResolvedValue(null);
    expect(await rejection(deleteRelease(RELEASE_ID))).toMatchObject({
      status: 404,
    });
  });
});

describe("openReleaseDownload", () => {
  it("streams the stored file for an engineer and logs the download", async () => {
    const stream = Readable.from([Buffer.from("jar")]);
    store.read.mockResolvedValue(stream);
    await expect(openReleaseDownload(RELEASE_ID)).resolves.toEqual({
      stream,
      fileName: "legacy-core-backend_TMLI-2026-11-2.jar",
      sizeBytes: 1234,
    });
    expect(store.read).toHaveBeenCalledWith(OBJECT_KEY);
    expect(activity.recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: USER_ID,
        action: "release.downloaded",
        data: {
          project: "TMLI",
          component: "legacy-core-backend",
          version: "TMLI 2026-11-2",
        },
      })
    );
  });

  it("is 409 releaseNotReady while preparing or after it failed", async () => {
    for (const status of ["preparing", "failed"]) {
      repo.getRelease.mockResolvedValue({
        ...readyRelease,
        status,
        objectKey: null,
        fileName: null,
        sizeBytes: null,
      });
      expect(await rejection(openReleaseDownload(RELEASE_ID))).toMatchObject({
        status: 409,
        code: "releaseNotReady",
      });
    }
    expect(store.read).not.toHaveBeenCalled();
  });

  it("is forbidden for QA", async () => {
    state.role = "qa";
    expect(await rejection(openReleaseDownload(RELEASE_ID))).toMatchObject({
      status: 403,
    });
    expect(store.read).not.toHaveBeenCalled();
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("is 503 when release storage is not configured", async () => {
    garage.configured = false;
    expect(await rejection(openReleaseDownload(RELEASE_ID))).toMatchObject({
      status: 503,
      code: "releaseStorageMissing",
    });
  });
});

describe("service-side input validation", () => {
  it("refuses an invalid version or notes with 400 before touching anything", async () => {
    for (const bad of [
      { deploymentId: DEPLOYMENT_ID, version: "x".repeat(101) },
      { deploymentId: DEPLOYMENT_ID, version: "a\nb" },
      { deploymentId: DEPLOYMENT_ID, version: "v1", notes: "n".repeat(2001) },
      { deploymentId: "nope", version: "v1" },
    ]) {
      expect(await rejection(createRelease(ENV_ID, bad))).toMatchObject({
        status: 400,
        code: "releaseInputInvalid",
      });
    }
    expect(repo.getReleaseSource).not.toHaveBeenCalled();
    expect(
      await rejection(updateReleaseNotes(RELEASE_ID, "n".repeat(2001)))
    ).toMatchObject({ status: 400, code: "releaseInputInvalid" });
    expect(repo.setReleaseNotes).not.toHaveBeenCalled();
  });

  it("stores the parsed (trimmed) values", async () => {
    await createRelease(ENV_ID, {
      deploymentId: DEPLOYMENT_ID,
      version: "  v1  ",
      notes: "   ",
    });
    expect(repo.insertReleaseWithRun).toHaveBeenCalledWith(
      expect.objectContaining({ version: "v1", notes: null }),
      expect.anything()
    );
    repo.setReleaseNotes.mockResolvedValue(readyRelease);
    await updateReleaseNotes(RELEASE_ID, "  hi  ");
    expect(repo.setReleaseNotes).toHaveBeenCalledWith(RELEASE_ID, "hi");
  });
});

describe("permission scope", () => {
  const scopeOf = () =>
    vi.mocked(requireProjectPermission).mock.calls.map((c) => c[0]);

  it("create is checked against the environment", async () => {
    await createRelease(ENV_ID, { deploymentId: DEPLOYMENT_ID, version: "v1" });
    expect(requireProjectPermission).toHaveBeenCalledWith(
      { environmentId: ENV_ID },
      { release: ["create"] }
    );
  });

  it("download and notes are checked against the release's own project", async () => {
    repo.getRelease.mockResolvedValue({
      ...readyRelease,
      projectId: OTHER_PROJECT_ID,
    });
    store.read.mockResolvedValue(Readable.from([]));
    repo.setReleaseNotes.mockResolvedValue(readyRelease);
    await openReleaseDownload(RELEASE_ID);
    await updateReleaseNotes(RELEASE_ID, "x");
    expect(scopeOf()).toEqual([
      { projectId: OTHER_PROJECT_ID },
      { projectId: OTHER_PROJECT_ID },
    ]);
    expect(vi.mocked(requireProjectPermission).mock.calls[0]?.[1]).toEqual({
      release: ["download"],
    });
    expect(vi.mocked(requireProjectPermission).mock.calls[1]?.[1]).toEqual({
      release: ["create"],
    });
  });
});

describe("deleteRelease racing the preparation job", () => {
  it("deletes the file of a release that became ready after it was read", async () => {
    repo.getRelease.mockResolvedValue({
      ...readyRelease,
      status: "preparing",
      objectKey: null,
    });
    repo.deleteReleaseRow.mockResolvedValue({ objectKey: OBJECT_KEY });
    await deleteRelease(RELEASE_ID);
    expect(store.delete).toHaveBeenCalledTimes(1);
    expect(store.delete).toHaveBeenCalledWith([OBJECT_KEY]);
  });

  it("does not delete the same key twice", async () => {
    repo.deleteReleaseRow.mockResolvedValue({ objectKey: OBJECT_KEY });
    await deleteRelease(RELEASE_ID);
    expect(store.delete).toHaveBeenCalledTimes(1);
  });
});
