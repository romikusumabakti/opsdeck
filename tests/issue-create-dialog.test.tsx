// @vitest-environment happy-dom
// The New issue dialog: borderless title + description, a chip row for the
// properties sent in one create request, Ctrl/⌘+Enter from anywhere (also
// inside the description editor; Enter in the title does not create), and
// "Create more" (keeps the properties, clears title/description, focuses the
// title). Property chips render read-only (no picker) for callers that may
// not change them.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editorMarkdown } from "@/lib/knowledge-editor-extensions";
import messages from "../messages/en.json";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const PROJECT_A = "00000000-0000-4000-8000-00000000000a";
const PROJECT_B = "00000000-0000-4000-8000-00000000000b";
const ENV_A = "00000000-0000-4000-8000-0000000000e1";
const ENV_B = "00000000-0000-4000-8000-0000000000e2";
const USER = "00000000-0000-4000-8000-0000000000f1";
const LABEL = "00000000-0000-4000-8000-0000000000c1";
const PARENT = "00000000-0000-4000-8000-0000000000d1";

const OPTIONS: Record<string, unknown> = {
  [PROJECT_A]: {
    environments: [{ id: ENV_A, name: "Staging" }],
    users: [{ id: USER, name: "Rina Hartono", image: null }],
    labels: [{ id: LABEL, name: "regression", color: "#dc2626" }],
    parents: [{ id: PARENT, number: 7, title: "Checkout epic" }],
  },
  [PROJECT_B]: {
    environments: [{ id: ENV_B, name: "Demo" }],
    users: [{ id: USER, name: "Rina Hartono", image: null }],
    labels: [{ id: LABEL, name: "regression", color: "#dc2626" }],
    parents: [],
  },
};

const createIssue = vi.fn();
vi.mock("@/web/api/issues", () => ({
  createIssue: (...args: unknown[]) => createIssue(...args),
  getIssueFormOptionsQuery: (projectId: string) => ({
    queryKey: ["issues", "getIssueFormOptions", [projectId]],
    queryFn: async () => OPTIONS[projectId],
  }),
}));
vi.mock("@/web/api/knowledge", () => ({
  listTreeNodesQuery: () => ({
    queryKey: ["knowledge", "listTreeNodes", []],
    queryFn: async () => [],
  }),
}));

import { IssueCreateDialog } from "@/components/issue-create-dialog";
import { StatusProperty } from "@/components/issue-property-trigger";

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  createIssue.mockReset();
  createIssue.mockResolvedValue({ success: true, data: { id: "x" } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

type DialogProps = React.ComponentProps<typeof IssueCreateDialog>;

function ui(props: Partial<DialogProps>) {
  return (
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <IssueCreateDialog
          open
          onOpenChange={() => {}}
          projectId={PROJECT_A}
          projectKey="SHOP"
          defaultEnvironmentId=""
          {...props}
        />
      </IntlProvider>
    </QueryClientProvider>
  );
}

async function mount(props: Partial<DialogProps> = {}) {
  await act(async () => {
    root.render(ui(props));
  });
  // Options loaded: the Create button waits for them.
  await vi.waitFor(() => {
    if (!chip("Environment")) throw new Error("no chips yet");
    if (!document.querySelector(".ProseMirror")) throw new Error("no editor");
  });
  await act(async () => {});
}

const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
const titleInput = () =>
  dialog().querySelector('input[aria-label="Title"]') as HTMLInputElement;
const createButton = () =>
  Array.from(dialog().querySelectorAll("button")).find(
    (b) => b.textContent === "Create issue"
  ) as HTMLButtonElement;
const editorDom = () => dialog().querySelector(".ProseMirror") as HTMLElement;

/** Text a screen reader gets (aria-hidden parts, e.g. avatar initials, out). */
function spoken(el: Element) {
  const copy = el.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
    hidden.remove();
  }
  return (copy.textContent ?? "").trim();
}

/** A chip by the start of its spoken text ("Status: Open", "Labels"). */
function chip(name: string) {
  const group = document.querySelector(
    '[role="group"][aria-label="Properties"]'
  );
  if (!group) return null;
  const found = Array.from(group.querySelectorAll<HTMLElement>("button")).find(
    (b) => spoken(b).startsWith(name)
  );
  return found ? Object.assign(found, { spoken: spoken(found) }) : null;
}

async function setTitle(value: string) {
  const input = titleInput();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function keyDown(target: Element, init: KeyboardEventInit) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
    );
  });
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    );
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    el.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, button: 0 })
    );
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });
}

/** Opens a chip and clicks the option whose text contains `text`. */
async function pick(chipName: string, text: string) {
  const trigger = chip(chipName);
  if (!trigger) throw new Error(`no chip ${chipName}`);
  // Comboboxes open on press, selects and popovers on click (happy-dom's
  // events carry no pointer type, so a full click would toggle twice).
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    );
    trigger.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 })
    );
  });
  if (trigger.getAttribute("aria-expanded") !== "true") await click(trigger);
  const option = await vi.waitFor(() => {
    const found = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"], [aria-pressed]')
    ).find((o) => (o.textContent ?? "").includes(text));
    if (!found) throw new Error(`no option ${text}`);
    return found;
  });
  await click(option);
  await act(async () => {});
}

async function closePopups() {
  await keyDown(document.activeElement ?? document.body, { key: "Escape" });
}

describe("New issue dialog", () => {
  it("shows a large title, the description editor and property chips", async () => {
    await mount();
    expect(titleInput()).not.toBeNull();
    expect(editorDom()).not.toBeNull();
    // Value when set, the property's name when empty.
    expect(chip("Status: Open")).not.toBeNull();
    expect(chip("Priority: Medium")).not.toBeNull();
    expect(chip("Type: Task")).not.toBeNull();
    expect(chip("Assignee")?.spoken).toBe("Assignee");
    expect(chip("Labels")?.spoken).toBe("Labels");
    expect(chip("Environment")?.spoken).toBe("Environment");
    expect(chip("Parent")?.spoken).toBe("Parent");
    // The Project chip belongs to the Home/global entry point only.
    expect(chip("Project")).toBeNull();
    expect(dialog().textContent).toContain("Create more");
  });

  it("shows the Project chip when the caller offers a project choice", async () => {
    await mount({
      projectChoice: {
        projects: [{ id: PROJECT_A, name: "Storefront", key: "SHOP" }],
        onChange: () => {},
      },
    });
    expect(chip("Project: Storefront")).not.toBeNull();
  });

  it("creates with every chosen property in one request", async () => {
    await mount();
    await setTitle("Checkout total off by one");
    await pick("Status", "In progress");
    await pick("Priority", "High");
    await pick("Assignee", "Rina Hartono");
    await pick("Environment", "Staging");
    await pick("Parent", "SHOP-7");
    await pick("Labels", "regression");
    await closePopups();
    await keyDown(titleInput(), { key: "Enter", ctrlKey: true });
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue).toHaveBeenCalledWith({
      projectId: PROJECT_A,
      title: "Checkout total off by one",
      description: "",
      type: "task",
      priority: "high",
      status: "in_progress",
      environmentId: ENV_A,
      assigneeId: USER,
      parentId: PARENT,
      labelIds: [LABEL],
    });
  });

  it("Enter in the title does not create; Ctrl/⌘+Enter in the description does", async () => {
    await mount({ defaults: { description: "Steps then result" } });
    await setTitle("Refund email missing");
    await keyDown(titleInput(), { key: "Enter" });
    expect(createIssue).not.toHaveBeenCalled();

    // Caret mid-text, where the editor's own Mod-Enter would add a line break.
    const editor = (editorDom() as HTMLElement & { editor: Editor }).editor;
    await act(async () => {
      editor.commands.focus(7);
    });
    await keyDown(editorDom(), { key: "Enter", ctrlKey: true });
    await vi.waitFor(() => expect(createIssue).toHaveBeenCalledTimes(1));
    expect(createIssue.mock.calls[0]?.[0].description).toBe(
      "Steps then result"
    );
    expect(editorMarkdown(editor)).toBe("Steps then result");

    // ⌘+Enter (macOS) from the title works the same.
    await keyDown(titleInput(), { key: "Enter", metaKey: true });
    await vi.waitFor(() => expect(createIssue).toHaveBeenCalledTimes(2));
  });

  it("closes after a create when Create more is off", async () => {
    const onOpenChange = vi.fn();
    const onCreated = vi.fn();
    await mount({ onOpenChange, onCreated });
    await setTitle("Slow search");
    await keyDown(titleInput(), { key: "Enter", ctrlKey: true });
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Create more keeps the dialog and the properties, clears the text, focuses the title", async () => {
    const onOpenChange = vi.fn();
    await mount({
      onOpenChange,
      defaults: { title: "Prefilled", description: "Seen on **staging**" },
    });
    // Prefill (Home/Assistant) still lands in the fields.
    expect(titleInput().value).toBe("Prefilled");
    expect(editorDom().textContent).toContain("Seen on staging");

    await pick("Priority", "Urgent");
    await pick("Environment", "Staging");
    await closePopups();
    const toggle = dialog().querySelector('[role="switch"]') as HTMLElement;
    await click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await keyDown(editorDom(), { key: "Enter", ctrlKey: true });
    await vi.waitFor(() => expect(createIssue).toHaveBeenCalledTimes(1));
    expect(createIssue.mock.calls[0]?.[0]).toMatchObject({
      title: "Prefilled",
      description: "Seen on **staging**",
    });

    await vi.waitFor(() => expect(titleInput().value).toBe(""));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(document.activeElement).toBe(titleInput());
    await vi.waitFor(() => expect(editorDom().textContent).toBe(""));
    expect(chip("Priority: Urgent")).not.toBeNull();
    expect(chip("Environment: Staging")).not.toBeNull();

    // The next one goes out with the kept properties.
    await setTitle("Second one");
    await keyDown(titleInput(), { key: "Enter", ctrlKey: true });
    await vi.waitFor(() => expect(createIssue).toHaveBeenCalledTimes(2));
    expect(createIssue.mock.calls[1]?.[0]).toMatchObject({
      title: "Second one",
      description: "",
      priority: "urgent",
      environmentId: ENV_A,
    });
  });

  it("a project change clears what no longer fits and keeps the rest", async () => {
    await mount();
    await setTitle("Moves projects");
    await pick("Priority", "Low");
    await pick("Environment", "Staging");
    await pick("Parent", "SHOP-7");
    await pick("Assignee", "Rina Hartono");
    await closePopups();

    await act(async () => {
      root.render(ui({ projectId: PROJECT_B, projectKey: "DEMO" }));
    });
    // Project B's lists are in once the Create button is back.
    await vi.waitFor(() => expect(createButton().disabled).toBe(false));
    expect(chip("Environment")?.spoken).toBe("Environment");
    expect(titleInput().value).toBe("Moves projects");
    expect(chip("Priority: Low")).not.toBeNull();
    expect(chip("Parent")?.spoken).toBe("Parent");
    // The assignee is a member of both projects: kept.
    expect(chip("Assignee: Rina Hartono")).not.toBeNull();

    await keyDown(titleInput(), { key: "Enter", ctrlKey: true });
    await vi.waitFor(() => expect(createIssue).toHaveBeenCalledTimes(1));
    expect(createIssue.mock.calls[0]?.[0]).toMatchObject({
      projectId: PROJECT_B,
      priority: "low",
      environmentId: null,
      parentId: null,
      assigneeId: USER,
    });
  });
});

describe("property triggers", () => {
  function html(node: React.ReactNode) {
    return renderToString(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        {node}
      </IntlProvider>
    );
  }

  it("render read-only (no picker) for a caller who may not change them", () => {
    for (const variant of ["chip", "row"] as const) {
      const out = html(
        <StatusProperty
          variant={variant}
          readOnly
          value="resolved"
          onChange={() => {}}
        />
      );
      expect(out).toContain("Resolved");
      expect(out).not.toContain("<button");
      expect(out).toContain("data-readonly");
    }
  });

  it("open a picker when changeable", () => {
    const out = html(
      <StatusProperty variant="row" value="open" onChange={() => {}} />
    );
    expect(out).toContain("<button");
    expect(out).toContain("Open");
  });
});
