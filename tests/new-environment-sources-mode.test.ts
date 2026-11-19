import { describe, expect, it } from "vitest";
import { sourcesModeProps } from "../web/routes/$locale/_app/-components/setup/sources-mode";

const kmem = {
  id: "app-kmem",
  appKey: "kmem",
  components: [{ componentKey: "kmem-api" }, { componentKey: "kmem-web" }],
};
const hris = {
  id: "app-hris",
  appKey: "hris",
  components: [{ componentKey: "hris-api" }],
};
const catalog = [kmem, hris];

describe("sourcesModeProps", () => {
  it("no sources keeps the whole catalog", () => {
    expect(sourcesModeProps(catalog, [])).toEqual({
      apps: catalog,
      sources: null,
    });
  });

  it("sources mode keeps only apps holding a project service, and the set defaults", () => {
    expect(
      sourcesModeProps(catalog, [
        { componentKey: "kmem-api", defaultBranch: "kestrel/development" },
        { componentKey: "kmem-web", defaultBranch: null },
      ])
    ).toEqual({
      apps: [kmem],
      sources: {
        appKeys: ["kmem"],
        defaultBranches: { "kmem-api": "kestrel/development" },
      },
    });
  });

  it("an app-less project service offers no app but keeps its default", () => {
    expect(
      sourcesModeProps(catalog, [
        { componentKey: "billing", defaultBranch: "main" },
      ])
    ).toEqual({
      apps: [],
      sources: { appKeys: [], defaultBranches: { billing: "main" } },
    });
  });
});
