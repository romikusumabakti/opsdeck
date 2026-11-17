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
});
