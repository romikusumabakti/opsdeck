import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The issue tables give their pill columns fixed widths (headClassName w-*).
// In an auto-layout table those widths are only hints: nowrap cells push the
// columns wider and the table overflows its card at 1440px. `table-fixed`
// makes the header widths hold and the title column take the rest.

describe("issue tables use a fixed layout", () => {
  // Class pins: SSR of DataTable needs the router and query providers, and
  // jsdom has no layout; the Playwright pass measures the real widths.
  it("DataTable passes tableClassName to the table element", () => {
    const source = readFileSync("components/ui/data-table.tsx", "utf8");
    expect(source).toMatch(
      /<Table\b[\s\S]*?className=\{cn\([\s\S]*?tableClassName/
    );
  });

  it("the project issues table is table-fixed", () => {
    const source = readFileSync(
      "web/routes/$locale/_app/-components/issues-client.tsx",
      "utf8"
    );
    expect(source).toMatch(/<Table\b[^>]*className="[^"]*\btable-fixed\b/);
  });

  it("the global issues table is table-fixed", () => {
    const source = readFileSync("components/global-issues-client.tsx", "utf8");
    expect(source).toMatch(/tableClassName="[^"]*\btable-fixed\b/);
  });

  // Linear-style: the title gets the most width, so the secondary columns
  // drop out below xl instead of squeezing it.
  it("hides environment and created below xl in the project table", () => {
    const source = readFileSync(
      "web/routes/$locale/_app/-components/issues-client.tsx",
      "utf8"
    );
    const hidden = source.match(/hidden [^"]*xl:table-cell/g) ?? [];
    expect(hidden.length).toBe(4);
  });

  // The global title takes the width the fixed columns leave (no cap), at
  // least 20rem: at 1280px with the sidebar open that is 50+ characters, so
  // Project, Created and Updated only join from 2xl. e2e/issue-create.spec.ts
  // measures it in a real browser.
  it("gives the global title the remaining width, at least 20rem", () => {
    const global = readFileSync("components/global-issues-client.tsx", "utf8");
    expect(global).not.toMatch(/max-w-\[28rem\]/);
    expect(global).toMatch(
      /headClassName: "min-w-80",\s*cellClassName: "overflow-hidden",\s*label: t\("columnTitle"\)/
    );
    expect(global).toMatch(/tableClassName="table-fixed min-w-\[54\.5rem\]"/);
    const hidden = global.match(/"hidden w-28 2xl:table-cell"/g) ?? [];
    expect(hidden.length).toBe(3);
    expect(global).not.toMatch(/[\s"]xl:table-cell/);
  });

  // Keys are up to 10 letters + "-" + number; w-32 shows DEMOPORTAL-12 whole.
  it("gives the key column w-32 and the full key as a tooltip", () => {
    const project = readFileSync(
      "web/routes/$locale/_app/-components/issues-client.tsx",
      "utf8"
    );
    expect(project).toContain('<TableHead className="w-32">{t("columnKey")}');
    expect(project).toMatch(/title=\{`\$\{projectKey\}-\$\{issue\.number\}`\}/);
    const global = readFileSync("components/global-issues-client.tsx", "utf8");
    expect(global).toMatch(
      /headClassName: "w-32",\s*cellClassName: "truncate",\s*label: t\("columnKey"\)/
    );
    expect(global).toMatch(
      /title=\{`\$\{row\.original\.project\.key\}-\$\{row\.original\.number\}`\}/
    );
  });
});
