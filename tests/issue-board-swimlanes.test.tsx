import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { IntlProvider } from "use-intl";
import { describe, expect, it, vi } from "vitest";
import { IssueBoard, type Swimlane } from "@/components/issues-board";
import en from "@/messages/en.json";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

function leaves(node: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      for (const [k, v] of leaves(value, path)) out.set(k, v);
    }
  } else {
    out.set(prefix, node);
  }
  return out;
}

const issues = [
  {
    id: "i1",
    number: 1,
    title: "Assigned issue",
    status: "open" as const,
    keyPrefix: "CMEM",
    assignee: { id: "u1", name: "Ada", image: null },
  },
  {
    id: "i2",
    number: 2,
    title: "Loose issue",
    status: "open" as const,
    keyPrefix: "CMEM",
    assignee: null,
  },
];

function board(swimlane: Swimlane) {
  return renderToString(
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      <IssueBoard
        issues={issues}
        onStatusChange={() => {}}
        swimlane={swimlane}
      />
    </IntlProvider>
  );
}

describe("issue board swimlanes", () => {
  it("an unknown swimlane (a stale group=milestone) renders the flat status board", () => {
    expect(board("milestone" as never)).toBe(board("none"));
  });

  it("the assignee swimlane still bands by assignee with Unassigned last", () => {
    const html = board("assignee");
    expect(html.indexOf("Ada")).toBeGreaterThan(-1);
    expect(html.indexOf("Ada")).toBeLessThan(
      html.indexOf(en.issues.unassigned)
    );
  });

  it.each(["en", "id", "es", "zh", "ar"])(
    "%s has no milestone key left",
    (l) => {
      const keys = JSON.stringify([
        ...leaves(
          JSON.parse(readFileSync(`messages/${l}.json`, "utf8"))
        ).keys(),
      ]);
      expect(keys).not.toMatch(/milestone/i);
    }
  );

  it("old milestone activity rows fall back to the generic sentence", () => {
    const page = readFileSync(
      "web/routes/$locale/_app/admin.activity.tsx",
      "utf8"
    );
    expect(page).not.toContain("milestone");
    expect(page).toContain('return t("unknown", { actor })');
  });
});
