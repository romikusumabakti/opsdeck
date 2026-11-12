import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

function between(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  expect(from, `${start} not found`).toBeGreaterThanOrEqual(0);
  return source.slice(from, source.indexOf(end, from));
}

describe("people picker data", () => {
  it("assignable users carry their email", () => {
    const block = between(
      read("server/services/users.ts"),
      "const assignableColumns",
      "};"
    );
    expect(block).toContain("email: userTable.email");
  });

  it("member candidates carry their avatar", () => {
    const block = between(
      read("server/services/project-members.ts"),
      "export async function listMemberCandidates",
      "orderBy"
    );
    expect(block).toContain("image: userTable.image");
  });
});
