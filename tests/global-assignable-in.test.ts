import { describe, expect, it } from "vitest";
import { assignableIn } from "@/components/global-issues-client";

const person = (id: string, projectIds: string[] | null) => ({
  id,
  name: id,
  image: null,
  projectIds,
});

const USERS = [
  person("admin", null),
  person("both", ["p1", "p2"]),
  person("p1-only", ["p1"]),
  person("none", []),
];

const ids = (list: { id: string }[]) => list.map((u) => u.id);

describe("assignableIn", () => {
  it("offers org-wide assignees and members of the project", () => {
    expect(ids(assignableIn(USERS, ["p1"]))).toEqual([
      "admin",
      "both",
      "p1-only",
    ]);
  });

  it("needs membership in every project of a mixed selection", () => {
    expect(ids(assignableIn(USERS, ["p1", "p2", "p1"]))).toEqual([
      "admin",
      "both",
    ]);
  });

  it("offers only org-wide assignees for a project nobody joined", () => {
    expect(ids(assignableIn(USERS, ["p3"]))).toEqual(["admin"]);
  });
});
