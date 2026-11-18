import type { Job } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The repeatable prunes are scheduled with `data: {}` and their payload
// schemas are strict: the legacy projectId → environmentId rewrite must not
// add a key to them (an `environmentId: undefined` key fails a strict schema).
const prunes = vi.hoisted(() => ({
  uploads: vi.fn(async () => {}),
  archives: vi.fn(async () => {}),
}));
vi.mock("@/lib/assistant/upload-prune", () => ({
  pruneUnsentUploads: prunes.uploads,
}));
vi.mock("@/server/services/environment-archives", () => ({
  pruneEnvironmentArchives: prunes.archives,
}));

const { processJob } = await import("@/lib/jobs/processor");

const job = (name: string, data: unknown) => ({ name, data }) as unknown as Job;

describe("scheduled prunes run with the payload the scheduler stores", () => {
  beforeEach(() => {
    prunes.uploads.mockClear();
    prunes.archives.mockClear();
  });

  it("assistant/uploads.prune", async () => {
    await processJob(job("assistant/uploads.prune", {}));
    expect(prunes.uploads).toHaveBeenCalledOnce();
  });

  it("environment/archives.prune", async () => {
    await processJob(job("environment/archives.prune", {}));
    expect(prunes.archives).toHaveBeenCalledOnce();
  });
});
