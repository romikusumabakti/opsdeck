import { describe, expect, it, vi } from "vitest";

// The assistant reads the running sources through lib/assistant/sources, which
// keeps its stored shape (conversation `sources` jsonb, the system prompt):
// the deployed tag is a dashboard field and stays out of it.

const running = vi.hoisted(() => ({ resolveRunningSources: vi.fn() }));
vi.mock("@/lib/running-sources", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...running,
}));

const { resolveEnvironmentSources } = await import("@/lib/assistant/sources");

describe("resolveEnvironmentSources", () => {
  it("returns the running sources without their tag", async () => {
    running.resolveRunningSources.mockResolvedValue([
      {
        componentKey: "api",
        repoFullName: "acme/api",
        ciConnectionId: "ci-1",
        commitSha: "abc",
        tag: "v1.2.3",
        ref: "abc",
        deployed: true,
        deployedAt: "2026-11-02T00:00:00.000Z",
      },
    ]);
    expect(await resolveEnvironmentSources("env-1")).toEqual([
      {
        componentKey: "api",
        repoFullName: "acme/api",
        ciConnectionId: "ci-1",
        commitSha: "abc",
        ref: "abc",
        deployed: true,
        deployedAt: "2026-11-02T00:00:00.000Z",
      },
    ]);
    expect(running.resolveRunningSources).toHaveBeenCalledWith("env-1");
  });
});
