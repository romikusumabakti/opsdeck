import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { pack } from "tar-stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";
const RELEASE_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const RUN_ID = "0197f3a0-1b2c-7def-8000-0123456789c1";
const TAG = "origin-release-tmli-abc1234";

const repo = vi.hoisted(() => ({
  getReleaseJobSubject: vi.fn(),
  getRelease: vi.fn(),
  markReleaseReady: vi.fn(),
  markReleaseFailed: vi.fn(),
}));
vi.mock("@/lib/releases/repository", () => repo);

const registry = vi.hoisted(() => ({ openArtifactLayer: vi.fn() }));
vi.mock("@/lib/registry/artifact", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/registry/artifact")>()),
  openArtifactLayer: registry.openArtifactLayer,
}));

const progress = vi.hoisted(() => ({
  appendRunOutput: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
}));
vi.mock("@/lib/run-progress", () => progress);

// What the store received: the key and the file's bytes at upload time.
const uploads = vi.hoisted(() => [] as { key: string; bytes: Buffer }[]);
const store = vi.hoisted(() => ({
  upload: vi.fn(),
  delete: vi.fn(),
  read: vi.fn(),
}));
const garage = vi.hoisted(() => ({ configured: true }));
vi.mock("@/lib/instance-backup/destination", () => ({
  garageSource: () => (garage.configured ? store : null),
}));

// Records every temp dir the job makes, to check it is removed.
const tempDirs = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const mkdtemp = async (prefix: string) => {
    const dir = await real.mkdtemp(prefix);
    tempDirs.push(dir);
    return dir;
  };
  return { ...real, default: { ...real, mkdtemp }, mkdtemp };
});

const { handlePrepareRelease } = await import("@/lib/jobs/release");
const { ArtifactImageError } = await import("@/lib/registry/artifact");

const JAR = Buffer.from("PK\u0003\u0004 pretend jar bytes");

async function layerOf(
  entries: { name: string; body: Buffer | string }[]
): Promise<ReadableStream<Uint8Array>> {
  const tar = pack();
  for (const e of entries) tar.entry({ name: e.name }, e.body);
  tar.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of tar) chunks.push(chunk as Buffer);
  const gz = await promisify(gzip)(Buffer.concat(chunks));
  return Readable.toWeb(
    Readable.from([gz])
  ) as unknown as ReadableStream<Uint8Array>;
}

const subject = {
  id: RELEASE_ID,
  projectId: PROJECT_ID,
  componentKey: "legacy-core-backend",
  environmentId: null,
  environmentName: "TMLI SIT",
  deploymentId: null,
  branch: "release/tmli",
  tag: TAG,
  commitSha: "abc1234def",
  version: "TMLI 2026-11-2",
  notes: null,
  status: "preparing",
  error: null,
  objectKey: null,
  fileName: null,
  sizeBytes: null,
  sha256: null,
  createdBy: null,
  createdAt: new Date(),
  readyAt: null,
  bundleImage: "legacy-core-backend-deploy",
  targetKind: "jar",
};

const FILE = "legacy-core-backend_TMLI-2026-11-2.jar";
const KEY = `releases/${PROJECT_ID}/legacy-core-backend/${RELEASE_ID}/${FILE}`;
const payload = { releaseId: RELEASE_ID, runId: RUN_ID };

function outputText(): string {
  return progress.appendRunOutput.mock.calls.map((c) => c[1]).join("\n");
}

beforeEach(async () => {
  vi.clearAllMocks();
  uploads.length = 0;
  tempDirs.length = 0;
  garage.configured = true;
  repo.getReleaseJobSubject.mockResolvedValue(subject);
  repo.markReleaseReady.mockResolvedValue(true);
  repo.markReleaseFailed.mockResolvedValue(true);
  store.upload.mockImplementation(async (key: string, filePath: string) => {
    uploads.push({ key, bytes: await readFile(filePath) });
  });
  registry.openArtifactLayer.mockImplementation(async () => ({
    size: 1,
    digest: `sha256:${"b".repeat(64)}`,
    stream: await layerOf([{ name: "bundle/artifact/core.jar", body: JAR }]),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handlePrepareRelease", () => {
  it("packages the layer, stores it under the release key and marks the release ready", async () => {
    await expect(handlePrepareRelease(payload)).resolves.toEqual({
      status: "ready",
    });
    expect(registry.openArtifactLayer).toHaveBeenCalledWith(
      "legacy-core-backend-deploy",
      TAG
    );
    expect(uploads).toEqual([{ key: KEY, bytes: JAR }]);
    expect(repo.markReleaseReady).toHaveBeenCalledWith(RELEASE_ID, {
      objectKey: KEY,
      fileName: FILE,
      sizeBytes: JAR.length,
      sha256: createHash("sha256").update(JAR).digest("hex"),
    });
    expect(progress.completeRun).toHaveBeenCalledWith(RUN_ID);
    expect(progress.failRun).not.toHaveBeenCalled();
    expect(tempDirs).toHaveLength(1);
    expect(existsSync(tempDirs[0] as string)).toBe(false);
  });

  it("zips a static artifact", async () => {
    repo.getReleaseJobSubject.mockResolvedValue({
      ...subject,
      componentKey: "legacy-core-frontend",
      bundleImage: "legacy-core-frontend-deploy",
      targetKind: "static",
    });
    registry.openArtifactLayer.mockImplementation(async () => ({
      size: 1,
      digest: `sha256:${"b".repeat(64)}`,
      stream: await layerOf([
        { name: "bundle/artifact/index.html", body: "<html></html>" },
      ]),
    }));
    await handlePrepareRelease(payload);
    expect(uploads[0]?.key).toBe(
      `releases/${PROJECT_ID}/legacy-core-frontend/${RELEASE_ID}/legacy-core-frontend_TMLI-2026-11-2.zip`
    );
    expect(uploads[0]?.bytes.subarray(0, 2).toString()).toBe("PK");
  });

  it("fails with a plain sentence when the registry no longer has the tag", async () => {
    registry.openArtifactLayer.mockRejectedValue(
      new Error(
        `artifact legacy-core-backend-deploy:${TAG} not found in the registry`
      )
    );
    await expect(handlePrepareRelease(payload)).resolves.toEqual({
      status: "failed",
    });
    const message = "The build's artifact is no longer in the registry";
    expect(repo.markReleaseFailed).toHaveBeenCalledWith(RELEASE_ID, message);
    expect(progress.failRun).toHaveBeenCalledWith(RUN_ID, message);
    expect(store.upload).not.toHaveBeenCalled();
    expect(repo.markReleaseReady).not.toHaveBeenCalled();
    expect(tempDirs.every((d) => !existsSync(d))).toBe(true);
  });

  it("fails with the error's message for a bad image or package", async () => {
    registry.openArtifactLayer.mockRejectedValue(
      new ArtifactImageError("found 2 layers, expected 1")
    );
    await handlePrepareRelease(payload);
    expect(repo.markReleaseFailed).toHaveBeenCalledWith(
      RELEASE_ID,
      "artifact image must be a single-layer Docker image (found 2 layers, expected 1)"
    );

    vi.clearAllMocks();
    repo.getReleaseJobSubject.mockResolvedValue(subject);
    registry.openArtifactLayer.mockImplementation(async () => ({
      size: 1,
      digest: `sha256:${"b".repeat(64)}`,
      stream: await layerOf([{ name: "bundle/artifact/README", body: "x" }]),
    }));
    await handlePrepareRelease(payload);
    expect(repo.markReleaseFailed).toHaveBeenCalledWith(
      RELEASE_ID,
      "artifact must contain exactly one jar"
    );
    expect(tempDirs.length).toBeGreaterThan(0);
    expect(tempDirs.every((d) => !existsSync(d))).toBe(true);
  });

  it("fails when release storage is not configured", async () => {
    garage.configured = false;
    await handlePrepareRelease(payload);
    expect(repo.markReleaseFailed).toHaveBeenCalledWith(
      RELEASE_ID,
      "Release storage is not configured"
    );
    expect(registry.openArtifactLayer).not.toHaveBeenCalled();
  });

  it("removes the temp dir when the upload fails, and keeps the error detail off the release", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    store.upload.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(handlePrepareRelease(payload)).resolves.toEqual({
      status: "failed",
    });
    expect(repo.markReleaseFailed).toHaveBeenCalledWith(
      RELEASE_ID,
      "Preparing the release failed"
    );
    expect(outputText()).toContain("connect ECONNREFUSED");
    expect(tempDirs).toHaveLength(1);
    expect(existsSync(tempDirs[0] as string)).toBe(false);
  });

  it("does nothing for a release that is no longer preparing", async () => {
    repo.getReleaseJobSubject.mockResolvedValue({
      ...subject,
      status: "ready",
    });
    await expect(handlePrepareRelease(payload)).resolves.toEqual({
      status: "already-finished",
    });
    expect(registry.openArtifactLayer).not.toHaveBeenCalled();
    expect(progress.completeRun).not.toHaveBeenCalled();
  });

  it("fails the run of a release that no longer exists", async () => {
    repo.getReleaseJobSubject.mockResolvedValue(null);
    await expect(handlePrepareRelease(payload)).resolves.toEqual({
      status: "missing",
    });
    expect(progress.failRun).toHaveBeenCalledWith(
      RUN_ID,
      "The release no longer exists"
    );
  });

  it("removes the stored file when the release was deleted while it was prepared", async () => {
    repo.markReleaseReady.mockResolvedValue(false);
    repo.getRelease.mockResolvedValue(null);
    await handlePrepareRelease(payload);
    expect(store.delete).toHaveBeenCalledWith([KEY]);
  });

  it("keeps the stored file when another delivery of the job already marked it ready", async () => {
    repo.markReleaseReady.mockResolvedValue(false);
    repo.getRelease.mockResolvedValue({ ...subject, status: "ready" });
    await handlePrepareRelease(payload);
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("deletes the uploaded file when marking the release ready throws", async () => {
    repo.markReleaseReady.mockRejectedValue(new Error("connection reset"));
    repo.getRelease.mockResolvedValue({ ...subject, status: "preparing" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(handlePrepareRelease(payload)).resolves.toEqual({
      status: "failed",
    });
    expect(store.delete).toHaveBeenCalledWith([KEY]);
    expect(repo.markReleaseFailed).toHaveBeenCalledWith(
      RELEASE_ID,
      "Preparing the release failed"
    );
  });

  it("keeps the uploaded file when the ready write committed after all", async () => {
    repo.markReleaseReady.mockRejectedValue(new Error("connection reset"));
    repo.getRelease.mockResolvedValue({
      ...subject,
      status: "ready",
      objectKey: KEY,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await handlePrepareRelease(payload);
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("does not delete anything when the upload itself failed", async () => {
    store.upload.mockRejectedValue(new Error("upload failed"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await handlePrepareRelease(payload);
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("fails when the deployment's target is gone", async () => {
    repo.getReleaseJobSubject.mockResolvedValue({
      ...subject,
      targetKind: null,
    });
    await handlePrepareRelease(payload);
    expect(repo.markReleaseFailed).toHaveBeenCalledWith(
      RELEASE_ID,
      "The release's deployment no longer exists"
    );
  });
});

describe("release/prepare.requested payload", async () => {
  const { parseJobPayload } = await import("@/lib/jobs/payloads");

  it("carries a release id and a run id, both uuids", () => {
    expect(parseJobPayload("release/prepare.requested", payload)).toEqual(
      payload
    );
    expect(() =>
      parseJobPayload("release/prepare.requested", {
        releaseId: "../etc",
        runId: RUN_ID,
      })
    ).toThrow(/release\/prepare\.requested/);
  });
});
