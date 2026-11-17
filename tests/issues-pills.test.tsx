// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPACT_TRIGGER } from "@/components/compact-trigger";
import {
  AssigneeSelect,
  PrioritySelect,
  StatusSelect,
} from "@/components/issues-board";
import messages from "../messages/en.json";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const LONG_NAME = "Alexandria Montgomery-Featherstonehaugh the Third";
const USERS = [
  { id: "u1", name: LONG_NAME, image: null, email: "a@acme.test" },
];

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        {node}
      </IntlProvider>
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function expectUniformPill(el: Element | null) {
  expect(el).not.toBeNull();
  const cls = el?.className.split(/\s+/) ?? [];
  expect(cls).toContain("data-[size=default]:h-7");
  expect(cls).toContain("shadow-none");
  expect(cls).toContain("font-normal");
  expect(cls).toContain("dark:bg-transparent");
  expect(cls).toContain("rounded-md");
  expect(cls).not.toContain("font-medium");
  expect(cls).not.toContain("shadow-xs");
}

describe("compact property pills", () => {
  it("status trigger neutralises the select resting styles", async () => {
    await render(
      <StatusSelect variant="compact" value="open" onChange={() => {}} />
    );
    expectUniformPill(container.querySelector('[data-slot="select-trigger"]'));
  });

  it("priority trigger neutralises the select resting styles", async () => {
    await render(
      <PrioritySelect variant="compact" value="high" onChange={() => {}} />
    );
    expectUniformPill(container.querySelector('[data-slot="select-trigger"]'));
  });

  it("assignee trigger matches and truncates a long name", async () => {
    await render(
      <AssigneeSelect
        variant="compact"
        users={USERS}
        value="u1"
        onChange={() => {}}
      />
    );
    const trigger = container.querySelector('[data-slot="combobox-trigger"]');
    expectUniformPill(trigger);
    const name = [...(trigger?.querySelectorAll("span") ?? [])].find(
      (s) => s.textContent === LONG_NAME
    );
    expect(name?.className).toContain("truncate");
  });

  it("exports a single shared class string", () => {
    expect(COMPACT_TRIGGER).toContain("max-w-full");
  });
});
