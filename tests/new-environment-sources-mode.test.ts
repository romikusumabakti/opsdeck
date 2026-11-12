import { describe, expect, it } from "vitest";
import { sourcesModeProps } from "../web/routes/$locale/_app/-components/setup/sources-mode";

const kmem = { id: "app-kmem", appKey: "kmem" };
const hris = { id: "app-hris", appKey: "hris" };
const catalog = [kmem, hris];

describe("sourcesModeProps", () => {
  it("no sources keeps the whole catalog", () => {
    expect(sourcesModeProps(catalog, [])).toEqual({
      apps: catalog,
      sources: null,
    });
  });

  it("sources mode keeps only source apps and the set defaults", () => {
    expect(
      sourcesModeProps(catalog, [
        {
          appId: "app-kmem",
          appKey: "kmem",
          components: [
            { componentKey: "kmem-api", defaultBranch: "kestrel/development" },
            { componentKey: "kmem-web", defaultBranch: null },
          ],
        },
      ])
    ).toEqual({
      apps: [kmem],
      sources: {
        appKeys: ["kmem"],
        defaultBranches: { "kmem-api": "kestrel/development" },
      },
    });
  });
});
