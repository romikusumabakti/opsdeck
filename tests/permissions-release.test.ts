import { describe, expect, it } from "vitest";
import { canProject } from "@/lib/permissions";

describe("release permission", () => {
  it("lets engineers create and download releases", () => {
    expect(canProject("engineer", { release: ["create"] })).toBe(true);
    expect(canProject("engineer", { release: ["download"] })).toBe(true);
  });

  it("keeps qa and viewer out", () => {
    expect(canProject("qa", { release: ["download"] })).toBe(false);
    expect(canProject("qa", { release: ["create"] })).toBe(false);
    expect(canProject("viewer", { release: ["create"] })).toBe(false);
    expect(canProject("viewer", { release: ["download"] })).toBe(false);
  });
});
