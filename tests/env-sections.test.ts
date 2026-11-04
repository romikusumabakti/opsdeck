import { describe, expect, it } from "vitest";
import { visibleEnvSections } from "@/lib/env-sections";

describe("visibleEnvSections", () => {
  it("hides databases for a backend-only environment", () => {
    const sections = visibleEnvSections({ services: [{ role: "backend" }] });
    expect(sections.has("databases")).toBe(false);
    expect(sections.has("mockTime")).toBe(true);
  });

  it("shows both for a full db + backend + frontend environment", () => {
    const sections = visibleEnvSections({
      services: [{ role: "db" }, { role: "backend" }, { role: "frontend" }],
    });
    expect(sections.has("databases")).toBe(true);
    expect(sections.has("mockTime")).toBe(true);
  });
});
