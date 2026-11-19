import { describe, expect, it } from "vitest";
import { sourcesModeProps } from "../web/routes/$locale/_app/-components/setup/sources-mode";

const catalog = [
  { componentKey: "billing" },
  { componentKey: "hris-api" },
  { componentKey: "kmem-api" },
  { componentKey: "kmem-web" },
];

describe("sourcesModeProps", () => {
  it("no sources keeps the whole catalog", () => {
    expect(sourcesModeProps(catalog, [])).toEqual({
      services: catalog,
      sources: null,
    });
  });

  it("sources mode offers only the project's services, with the set defaults", () => {
    expect(
      sourcesModeProps(catalog, [
        { componentKey: "kmem-web", defaultBranch: null },
        { componentKey: "kmem-api", defaultBranch: "kestrel/development" },
      ])
    ).toEqual({
      services: [{ componentKey: "kmem-api" }, { componentKey: "kmem-web" }],
      sources: {
        serviceKeys: ["kmem-api", "kmem-web"],
        defaultBranches: { "kmem-api": "kestrel/development" },
      },
    });
  });

  it("offers a service registered without an app like any other", () => {
    expect(
      sourcesModeProps(catalog, [
        { componentKey: "billing", defaultBranch: "main" },
      ])
    ).toEqual({
      services: [{ componentKey: "billing" }],
      sources: {
        serviceKeys: ["billing"],
        defaultBranches: { billing: "main" },
      },
    });
  });
});
