import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { IntlProvider } from "use-intl";
import { describe, expect, it } from "vitest";
import {
  AssigneeSelect,
  PrioritySelect,
  type SelectVariant,
  StatusSelect,
} from "@/components/issues-board";
import messages from "@/messages/en.json";

const COMPACT = [
  "h-7",
  "w-auto",
  "max-w-full",
  "border-transparent",
  "bg-transparent",
  "px-2",
  "hover:bg-muted",
];

function wrap(node: React.ReactNode) {
  return renderToString(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </IntlProvider>
  );
}

const noop = () => {};

function statusHtml(variant?: SelectVariant) {
  return wrap(<StatusSelect value="open" onChange={noop} variant={variant} />);
}
function priorityHtml(variant?: SelectVariant) {
  return wrap(
    <PrioritySelect value="medium" onChange={noop} variant={variant} />
  );
}
function assigneeHtml(variant?: SelectVariant) {
  return wrap(
    <AssigneeSelect
      users={[{ id: "u1", name: "Ada Lovelace", image: null }]}
      value={null}
      onChange={noop}
      variant={variant}
    />
  );
}

function triggerClass(html: string) {
  // Status and Priority use a Select; the assignee is a PersonPicker Combobox.
  const tag =
    html.match(/<[^>]*data-slot="(?:select|combobox)-trigger"[^>]*>/)?.[0] ??
    "";
  // React escapes `&` and `>` in attribute values (arbitrary variants).
  return (tag.match(/class="([^"]*)"/)?.[1] ?? "")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

describe("issue selects compact variant", () => {
  it("Status, Priority and Assignee share the compact trigger classes", () => {
    for (const html of [
      statusHtml("compact"),
      priorityHtml("compact"),
      assigneeHtml("compact"),
    ]) {
      const cls = triggerClass(html).split(/\s+/);
      for (const token of COMPACT) expect(cls).toContain(token);
      expect(cls).not.toContain("w-full");
    }
  });

  it("the cell variant fills its column with an end-aligned chevron shown on row hover/focus", () => {
    for (const html of [
      statusHtml("cell"),
      priorityHtml("cell"),
      assigneeHtml("cell"),
    ]) {
      const cls = triggerClass(html).split(/\s+/);
      // The ghost look of compact, but the full column width, so every row's
      // control is as wide as the next one.
      for (const token of [
        "h-7",
        "border-transparent",
        "bg-transparent",
        "hover:bg-muted",
        "w-full",
        "justify-between",
      ])
        expect(cls).toContain(token);
      expect(cls).not.toContain("w-auto");
      // The chevron (the trigger's last svg) rests hidden and appears while
      // the row is hovered or holds focus, or the popup is open.
      for (const token of [
        "[&>svg:last-child]:opacity-0",
        "in-[tr:hover]:[&>svg:last-child]:opacity-100",
        "in-[tr:focus-within]:[&>svg:last-child]:opacity-100",
        "data-popup-open:[&>svg:last-child]:opacity-100",
      ])
        expect(cls).toContain(token);
      // The chevron is the trigger's last element child.
      const chevron = html.match(
        /data-slot="(?:select|combobox)-trigger"[\s\S]*?<\/button>/
      )?.[0];
      expect(chevron?.trim().endsWith("</svg></button>")).toBe(true);
    }
  });

  it("the default variant keeps the bordered full-width trigger", () => {
    for (const html of [statusHtml(), priorityHtml(), assigneeHtml()]) {
      const cls = triggerClass(html).split(/\s+/);
      expect(cls).toContain("h-8");
      expect(cls).toContain("w-full");
      expect(cls).not.toContain("border-transparent");
    }
  });

  const inlineUses = (file: string) =>
    readFileSync(file, "utf8").match(
      /<(StatusSelect|PrioritySelect|AssigneeSelect)\b[\s\S]*?\n\s*\/>/g
    ) ?? [];

  it("every inline issue select passes variant compact or cell", () => {
    for (const file of [
      "components/global-issues-client.tsx",
      "web/routes/$locale/_app/-components/issues-client.tsx",
      "components/issues-board.tsx",
    ]) {
      const uses = inlineUses(file);
      expect(uses.length, file).toBeGreaterThan(0);
      for (const use of uses)
        expect(use, file).toMatch(/variant="(compact|cell)"/);
    }
  });

  it("table rows use the cell variant; cards and the board keep compact", () => {
    // The project table's three row controls.
    const project = inlineUses(
      "web/routes/$locale/_app/-components/issues-client.tsx"
    );
    expect(project).toHaveLength(3);
    for (const use of project) expect(use).toContain('variant="cell"');
    // The global table's column cells are cell; its mobile cards compact.
    const global = inlineUses("components/global-issues-client.tsx");
    expect(global.filter((u) => u.includes('variant="cell"'))).toHaveLength(3);
    expect(global.filter((u) => u.includes('variant="compact"'))).toHaveLength(
      3
    );
    for (const use of inlineUses("components/issues-board.tsx"))
      expect(use).toContain('variant="compact"');
  });

  it("forms keep the default variant", () => {
    for (const file of [
      "components/issue-create-dialog.tsx",
      "web/routes/$locale/_app/-components/project/issue-detail-client.tsx",
    ])
      expect(readFileSync(file, "utf8")).not.toContain('variant="compact"');
  });

  // Class pins: SSR cannot measure layout, so these guard the classes that make
  // a long assignee name truncate instead of widening an auto-layout column.
  it("pins the assignee truncation classes (class pin, not a layout test)", () => {
    const picker = readFileSync("components/person-picker.tsx", "utf8");
    expect(picker).toMatch(/<span className="truncate">\s*\{person\.name\}/);
    expect(picker).toContain(
      '<span className="flex min-w-0 items-center gap-1.5">'
    );
    expect(picker).toContain('<span className="flex min-w-0 flex-col">');
  });

  // Table cells are table-fixed (tests/issues-table-layout.test.tsx), so the
  // trigger's own max-w-full bounds it; only the flex card layout needs a cap.
  it("caps the compact assignee trigger only in the card layout", () => {
    const uses = (file: string) =>
      readFileSync(file, "utf8").match(/<AssigneeSelect\b[\s\S]*?\n\s*\/>/g) ??
      [];
    const global = uses("components/global-issues-client.tsx");
    expect(global.some((u) => u.includes('className="max-w-40"'))).toBe(true);
    expect(global.some((u) => u.includes('className="max-w-32"'))).toBe(false);
    const project = uses(
      "web/routes/$locale/_app/-components/issues-client.tsx"
    );
    expect(project.some((u) => u.includes("max-w-32"))).toBe(false);
  });
});
