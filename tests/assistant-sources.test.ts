import { describe, expect, it } from "vitest";
import { pickRunningCommit } from "@/lib/assistant/sources";

const d = (
  over: Partial<{
    status: string;
    buildId: string | null;
    tag: string;
    createdAt: Date;
    finishedAt: Date | null;
  }>
) => ({
  status: "success",
  buildId: null,
  tag: "t",
  createdAt: new Date("2026-11-01T00:00:00Z"),
  finishedAt: null,
  ...over,
});
const b = (id: string, tag: string, commitSha: string, at = "2026-11-01") => ({
  id,
  tag,
  commitSha,
  receivedAt: new Date(`${at}T00:00:00Z`),
});

describe("pickRunningCommit", () => {
  it("picks the newest succeeded deployment through its build id", () => {
    const result = pickRunningCommit(
      [
        d({ buildId: "b1", createdAt: new Date("2026-11-01T00:00:00Z") }),
        d({
          buildId: "b2",
          createdAt: new Date("2026-11-02T00:00:00Z"),
          finishedAt: new Date("2026-11-02T00:05:00Z"),
        }),
      ],
      [b("b1", "t1", "aaa"), b("b2", "t2", "bbb")]
    );
    expect(result).toEqual({
      commitSha: "bbb",
      deployedAt: "2026-11-02T00:05:00.000Z",
    });
  });

  it("ignores failed, queued and other non-success deployments", () => {
    const result = pickRunningCommit(
      [
        d({ buildId: "b1", createdAt: new Date("2026-11-01T00:00:00Z") }),
        d({
          status: "failed",
          buildId: "b2",
          createdAt: new Date("2026-11-03T00:00:00Z"),
        }),
        d({
          status: "queued",
          buildId: "b2",
          createdAt: new Date("2026-11-04T00:00:00Z"),
        }),
      ],
      [b("b1", "t1", "aaa"), b("b2", "t2", "bbb")]
    );
    expect(result?.commitSha).toBe("aaa");
    expect(result?.deployedAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("falls back to the newest build with the same tag when build id is null", () => {
    const result = pickRunningCommit(
      [d({ tag: "v1" })],
      [
        b("x", "v0", "old"),
        b("y", "v1", "first", "2026-11-01"),
        b("z", "v1", "second", "2026-11-05"),
      ]
    );
    expect(result?.commitSha).toBe("second");
  });

  it("returns null when no deployment succeeded", () => {
    expect(
      pickRunningCommit(
        [d({ status: "failed", buildId: "b1" })],
        [b("b1", "t", "aaa")]
      )
    ).toBeNull();
    expect(pickRunningCommit([], [])).toBeNull();
  });

  it("returns null when the newest succeeded deployment has no matching build", () => {
    expect(
      pickRunningCommit([d({ tag: "gone" })], [b("b1", "t", "a")])
    ).toBeNull();
  });
});
