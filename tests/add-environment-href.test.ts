import { describe, expect, it } from "vitest";
import { addEnvironmentHref } from "@/web/api/apps";

// "Add environment" on a repository page goes straight to the final page.

const app = { id: "app-1", components: [{ repoFullName: "dss/hris" }] };
const project = (key: string, appIds: (string | null)[]) => ({
  key,
  environments: appIds.map((appId) => ({ appId })),
});

describe("addEnvironmentHref", () => {
  it("opens the one project holding the app's environments, repo preselected", () => {
    expect(
      addEnvironmentHref(app, [
        project("HRIS", ["app-1"]),
        project("X", [null]),
      ])
    ).toBe("/HRIS/environments/new?repo=dss%2Fhris");
  });

  it("goes to the projects list when no single project holds the app", () => {
    expect(addEnvironmentHref(app, [project("A", [null])])).toBe(
      "/projects?newEnvironment=1"
    );
    expect(
      addEnvironmentHref(app, [
        project("A", ["app-1"]),
        project("B", ["app-1"]),
      ])
    ).toBe("/projects?newEnvironment=1");
  });

  it("prefers an explicit project key", () => {
    expect(
      addEnvironmentHref(
        app,
        [project("A", ["app-1"]), project("B", ["app-1"])],
        "b"
      )
    ).toBe("/B/environments/new?repo=dss%2Fhris");
  });

  it("leaves the repo out for an app without components", () => {
    expect(
      addEnvironmentHref({ id: "app-1", components: [] }, [
        project("A", ["app-1"]),
      ])
    ).toBe("/A/environments/new");
  });
});
