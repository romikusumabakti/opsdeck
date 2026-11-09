import { describe, expect, it } from "vitest";
import { channelOf, compareVersions, parseVersion } from "@/lib/version";

describe("parseVersion", () => {
  it("parses a beta tag and accepts a leading v", () => {
    expect(parseVersion("v1.2.3-beta.4")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      beta: 4,
    });
  });

  it("parses a stable version with no beta number", () => {
    expect(parseVersion("1.0.0")).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      beta: null,
    });
  });

  it.each(["1.2", "", "1.2.3-rc.1", "1.2.3-beta", "a.b.c"])(
    "rejects %j",
    (v) => {
      expect(parseVersion(v)).toBeNull();
    }
  );
});

describe("compareVersions", () => {
  it("orders a beta before the stable of the same X.Y.Z", () => {
    expect(compareVersions("1.2.3-beta.9", "1.2.3")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3-beta.9")).toBe(1);
  });

  it("compares numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
  });

  it("orders betas by number and treats equal versions as equal", () => {
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });

  it("throws on an unparseable version", () => {
    expect(() => compareVersions("nope", "1.0.0")).toThrow();
  });
});

describe("channelOf", () => {
  it("maps betas to beta and everything else to stable", () => {
    expect(channelOf("1.0.0-beta.1")).toBe("beta");
    expect(channelOf("1.0.0")).toBe("stable");
  });
});
