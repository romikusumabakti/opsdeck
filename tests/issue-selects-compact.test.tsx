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
  return tag.match(/class="([^"]*)"/)?.[1] ?? "";
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

  it("the default variant keeps the bordered full-width trigger", () => {
    for (const html of [statusHtml(), priorityHtml(), assigneeHtml()]) {
      const cls = triggerClass(html).split(/\s+/);
      expect(cls).toContain("h-8");
      expect(cls).toContain("w-full");
      expect(cls).not.toContain("border-transparent");
    }
  });

  it("every inline issue select passes variant compact", () => {
    for (const file of [
      "components/global-issues-client.tsx",
      "web/routes/$locale/_app/-components/issues-client.tsx",
      "components/issues-board.tsx",
    ]) {
      const uses =
        readFileSync(file, "utf8").match(
          /<(StatusSelect|PrioritySelect|AssigneeSelect)\b[\s\S]*?\n\s*\/>/g
        ) ?? [];
      expect(uses.length, file).toBeGreaterThan(0);
      for (const use of uses) expect(use, file).toContain('variant="compact"');
    }
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
    expect(picker).toContain('<span className="truncate">{person.name}</span>');
    expect(picker).toContain(
      '<span className="flex min-w-0 items-center gap-1.5">'
    );
    expect(picker).toContain('<span className="flex min-w-0 flex-col">');
  });

  it("caps the compact assignee trigger at every call site", () => {
    for (const { file, cap } of [
      { file: "components/global-issues-client.tsx", cap: "max-w-32" },
      { file: "components/global-issues-client.tsx", cap: "max-w-40" },
      {
        file: "web/routes/$locale/_app/-components/issues-client.tsx",
        cap: "max-w-32",
      },
    ]) {
      const uses =
        readFileSync(file, "utf8").match(
          /<AssigneeSelect\b[\s\S]*?\n\s*\/>/g
        ) ?? [];
      expect(
        uses.some((u) => u.includes(`className="${cap}"`)),
        `${file} ${cap}`
      ).toBe(true);
    }
  });
});
