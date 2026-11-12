import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const COMPONENTS = "web/routes/$locale/_app/-components";

const assigneeSelect = () => {
  const source = read("components/issues-board.tsx");
  const start = source.indexOf("export function AssigneeSelect");
  const end = source.indexOf("// Kanban-by-status board");
  return source.slice(start, end);
};

const sites: [string, () => string][] = [
  ["AssigneeSelect", assigneeSelect],
  [
    "kind-owner-fields",
    () => read(`${COMPONENTS}/setup/kind-owner-fields.tsx`),
  ],
  ["general-tab", () => read(`${COMPONENTS}/env/settings/general-tab.tsx`)],
  [
    "project-members-client",
    () => read(`${COMPONENTS}/project/project-members-client.tsx`),
  ],
];

describe("PersonPicker adoption", () => {
  it.each(sites)("no person Select remains in %s", (_name, source) => {
    expect(source()).not.toContain("<SelectItem key={u.id}");
    expect(source()).toContain("<PersonPicker");
  });

  it("AssigneeSelect passes the unassigned none item", () => {
    expect(read("components/issues-board.tsx")).toContain(
      'noneLabel={t("unassigned")}'
    );
  });
});
