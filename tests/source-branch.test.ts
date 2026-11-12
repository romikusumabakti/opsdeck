import { describe, expect, it } from "vitest";
import {
  branchChip,
  fallbackBranch,
  initialRepoBranch,
} from "@/lib/setup/source-branch";

describe("source branch rules", () => {
  it("fallbackBranch: build spec's first branch, else main", () => {
    expect(fallbackBranch({ branches: ["release/car", "car/mpl-ml"] })).toBe(
      "release/car"
    );
    expect(fallbackBranch({ branches: [] })).toBe("main");
    expect(fallbackBranch(null)).toBe("main");
    expect(fallbackBranch(undefined)).toBe("main");
  });

  it("initialRepoBranch: the project default beats the build spec and the repo default", () => {
    expect(
      initialRepoBranch({
        projectDefault: "kestrel/development",
        specBranches: ["release/car"],
        repoDefault: "master",
      })
    ).toBe("kestrel/development");
    expect(
      initialRepoBranch({
        specBranches: ["release/car"],
        repoDefault: "master",
      })
    ).toBe("release/car");
    expect(initialRepoBranch({ repoDefault: "master" })).toBe("master");
    expect(initialRepoBranch({})).toBe("main");
  });

  it("branchChip", () => {
    expect(branchChip(null, "main")).toBe("noTarget");
    expect(branchChip("main", "main")).toBe("matches");
    expect(branchChip("kestrel/demo", "kestrel/development")).toBe("differs");
  });
});
