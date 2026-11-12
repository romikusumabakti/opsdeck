import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";
const DEPLOYMENT_ID = "0197f3a0-1b2c-7def-8000-0123456789d1";
const RELEASE_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const RUN_ID = "0197f3a0-1b2c-7def-8000-0123456789c1";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789b1";
const OBJECT_KEY = `releases/${PROJECT_ID}/legacy-core-backend/${RELEASE_ID}/legacy-core-backend_v1.jar`;

const state = vi.hoisted(() => ({
  role: "engineer" as string,
  orgRole: "admin" as string,
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: "user-1" } })),
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

vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueue: vi.fn() }));
vi.mock("@/lib/run-progress", () => ({
  appendRunOutput: vi.fn(),
  failRun: vi.fn(),
}));

const store = vi.hoisted(() => ({
  read: vi.fn(),
  delete: vi.fn(),
  upload: vi.fn(),
}));
vi.mock("@/lib/instance-backup/destination", () => ({
  garageSource: () => store,
}));

const { app } = await import("@/server/app");
const { enqueue } = await import("@/lib/queue");

const release = {
  id: RELEASE_ID,
  projectId: PROJECT_ID,
  projectName: "TMLI",
  componentKey: "legacy-core-backend",
  version: "v1",
  notes: null,
  status: "ready",
  objectKey: OBJECT_KEY,
  fileName: "legacy-core-backend_v1.jar",
  sizeBytes: 1234,
};

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const createPath = `/api/environments/${ENV_ID}/releases`;
const downloadPath = `/api/releases/${RELEASE_ID}/download`;

beforeEach(() => {
  vi.resetAllMocks();
  state.role = "engineer";
  state.orgRole = "admin";
  repo.getRelease.mockResolvedValue(release);
  repo.getReleaseSource.mockResolvedValue({
    deploymentId: DEPLOYMENT_ID,
    environmentId: ENV_ID,
    environmentName: "TMLI SIT",
    projectName: "TMLI",
    componentKey: "legacy-core-backend",
    targetKind: "jar",
    status: "success",
    branch: "release/tmli",
    tag: "origin-release-tmli-abc1234",
    commitSha: "abc1234def",
  });
  repo.insertReleaseWithRun.mockResolvedValue({
    releaseId: RELEASE_ID,
    runId: RUN_ID,
  });
  repo.listProjectReleases.mockResolvedValue([release]);
  repo.setReleaseNotes.mockResolvedValue({ ...release, notes: "n" });
  repo.deleteReleaseRow.mockResolvedValue({ objectKey: OBJECT_KEY });
});

describe("POST /api/environments/:id/releases", () => {
  it("answers 202 with the release and run ids and queues the job", async () => {
    const res = await send("POST", createPath, {
      deploymentId: DEPLOYMENT_ID,
      version: "v1",
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ releaseId: RELEASE_ID, runId: RUN_ID });
    expect(enqueue).toHaveBeenCalledWith("release/prepare.requested", {
      releaseId: RELEASE_ID,
      runId: RUN_ID,
    });
  });

  it("is 400 for a version of 101 characters or an unknown key", async () => {
    for (const body of [
      { deploymentId: DEPLOYMENT_ID, version: "x".repeat(101) },
      { deploymentId: DEPLOYMENT_ID, version: "v1", extra: true },
    ]) {
      expect((await send("POST", createPath, body)).status).toBe(400);
    }
    expect(repo.insertReleaseWithRun).not.toHaveBeenCalled();
  });

  it("is 403 for QA", async () => {
    state.role = "qa";
    const res = await send("POST", createPath, {
      deploymentId: DEPLOYMENT_ID,
      version: "v1",
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/projects/:id/releases", () => {
  it("lists the releases with the bytes they store", async () => {
    const res = await send("GET", `/api/projects/${PROJECT_ID}/releases`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalBytes).toBe(1234);
    expect(body.releases).toHaveLength(1);
  });

  it("is open to QA", async () => {
    state.role = "qa";
    const res = await send("GET", `/api/projects/${PROJECT_ID}/releases`);
    expect(res.status).toBe(200);
  });
});

describe("PATCH /api/releases/:id", () => {
  it("updates the notes", async () => {
    const res = await send("PATCH", `/api/releases/${RELEASE_ID}`, {
      notes: "n",
    });
    expect(res.status).toBe(200);
    expect(repo.setReleaseNotes).toHaveBeenCalledWith(RELEASE_ID, "n");
  });

  it("is 400 for other fields and 404 for an unknown release", async () => {
    expect(
      (await send("PATCH", `/api/releases/${RELEASE_ID}`, { version: "v2" }))
        .status
    ).toBe(400);
    repo.getRelease.mockResolvedValue(undefined);
    expect(
      (await send("PATCH", `/api/releases/${RELEASE_ID}`, { notes: null }))
        .status
    ).toBe(404);
  });
});

describe("DELETE /api/releases/:id", () => {
  it("is 204 for an admin and deletes the object", async () => {
    const res = await send("DELETE", `/api/releases/${RELEASE_ID}`);
    expect(res.status).toBe(204);
    expect(store.delete).toHaveBeenCalledWith([OBJECT_KEY]);
  });

  it("is 403 for a non-admin", async () => {
    state.orgRole = "engineer";
    const res = await send("DELETE", `/api/releases/${RELEASE_ID}`);
    expect(res.status).toBe(403);
    expect(store.delete).not.toHaveBeenCalled();
  });
});

describe("GET /api/releases/:id/download", () => {
  it("streams the stored bytes with the download headers", async () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024, 7);
    // Chunks of 64 KiB: the route must pass the stream through, not collect it.
    const chunks: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += 65536) {
      chunks.push(bytes.subarray(i, i + 65536));
    }
    store.read.mockResolvedValue(Readable.from(chunks));
    repo.getRelease.mockResolvedValue({ ...release, sizeBytes: bytes.length });

    const res = await send("GET", downloadPath);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/java-archive");
    expect(res.headers.get("Content-Length")).toBe(String(bytes.length));
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="legacy-core-backend_v1.jar"; filename*=UTF-8''legacy-core-backend_v1.jar`
    );

    const received = Buffer.from(await res.arrayBuffer());
    expect(received.equals(bytes)).toBe(true);
    expect(store.read).toHaveBeenCalledWith(OBJECT_KEY);
  });

  it("passes a bounded source through without draining it, and releases it on abort", async () => {
    const TOTAL = 64;
    let yielded = 0;
    const source = new Readable({
      highWaterMark: 65536,
      read() {
        yielded += 1;
        this.push(yielded <= TOTAL ? Buffer.alloc(65536, 1) : null);
      },
    });
    store.read.mockResolvedValue(source);
    repo.getRelease.mockResolvedValue({ ...release, sizeBytes: TOTAL * 65536 });

    const res = await send("GET", downloadPath);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(yielded).toBeLessThan(TOTAL);

    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(source.destroyed).toBe(true);
  });

  it("cannot be header-injected through the file name", async () => {
    repo.getRelease.mockResolvedValue({
      ...release,
      fileName: 'a"b\\c\r\nX-Evil: 1.jar',
    });
    store.read.mockResolvedValue(Readable.from([Buffer.from("x")]));
    const res = await send("GET", downloadPath);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Evil")).toBeNull();
    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toContain('filename="a_b_c__X-Evil: 1.jar"');
    expect(disposition).toContain(
      "filename*=UTF-8''a%22b%5Cc%0D%0AX-Evil%3A%201.jar"
    );
    await res.arrayBuffer();
  });

  it("serves a static release as application/zip", async () => {
    repo.getRelease.mockResolvedValue({
      ...release,
      fileName: "web_v1.zip",
    });
    store.read.mockResolvedValue(Readable.from([Buffer.from("zip")]));
    const res = await send("GET", downloadPath);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    await res.arrayBuffer();
  });

  it("is 409 releaseNotReady while the release is preparing", async () => {
    repo.getRelease.mockResolvedValue({
      ...release,
      status: "preparing",
      objectKey: null,
      fileName: null,
      sizeBytes: null,
    });
    const res = await send("GET", downloadPath);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("releaseNotReady");
  });

  it("is 403 for QA", async () => {
    state.role = "qa";
    const res = await send("GET", downloadPath);
    expect(res.status).toBe(403);
    expect(store.read).not.toHaveBeenCalled();
  });

  it("is 404 releaseFileMissing when the object is gone", async () => {
    store.read.mockRejectedValue(
      Object.assign(new Error("gone"), { name: "NoSuchKey" })
    );
    const res = await send("GET", downloadPath);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("releaseFileMissing");
    expect(body.error).toBe("The release file is missing from storage");
  });

  it("does not crash when the stream fails after the headers were sent", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    process.on("uncaughtException", unhandled);
    let sent = false;
    const stream = new Readable({
      read() {
        // Send one chunk, then drop the connection (pushing on every read
        // would starve the setImmediate and loop without end).
        if (sent) return;
        sent = true;
        this.push(Buffer.from("partial"));
        setImmediate(() => this.destroy(new Error("connection reset")));
      },
    });
    store.read.mockResolvedValue(stream);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await send("GET", downloadPath);
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(unhandled).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    process.off("unhandledRejection", unhandled);
    process.off("uncaughtException", unhandled);
    log.mockRestore();
  });
});
