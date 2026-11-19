import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The global Issues page is a New issue entry point like Home: the same
// provider (projects the caller may file in, last-opened writable environment
// as the default) and the same button, which hides itself when there is no
// such project. The route needs the router, so this pins the wiring; the
// e2e (e2e/issue-create.spec.ts) clicks it in a real browser.
describe("global Issues: New issue", () => {
  const source = readFileSync("web/routes/$locale/_app/issues.tsx", "utf8");

  it("wraps the page in Home's issue dialog provider", () => {
    expect(source).toMatch(
      /<HomeIssueDialogProvider projects=\{issueProjects\} defaultTarget=\{target\}>/
    );
    expect(source).toContain("listIssueProjectsQuery()");
    expect(source).toContain("defaultIssueTarget(");
  });

  it("puts NewIssueButton in the page header", () => {
    expect(source).toMatch(/<PageHeader[\s\S]*?action=\{<NewIssueButton \/>\}/);
  });
});
