// @vitest-environment happy-dom
// The issue page (Linear pattern): a main column with a borderless title and
// description that save on blur (title also on Enter) with the `updatedAt` the
// page last saw, inline Saved / error feedback, a "Changed by someone else"
// banner on 409 that reloads the server version and keeps the user's text to
// copy; a properties sidebar from `lg` and a chip row below it. Without
// `issue: write` everything is read-only (no pickers, no editors).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueDetail } from "@/web/api/issues";
import messages from "../messages/en.json";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  useRouter: () => ({ refresh: vi.fn() }),
}));

const updateIssue = vi.fn();
vi.mock("@/web/api/issues", () => ({
  updateIssue: (...args: unknown[]) => updateIssue(...args),
  addComment: vi.fn(),
}));
const setIssueLabels = vi.fn();
vi.mock("@/web/api/labels", () => ({
  setIssueLabels: (...args: unknown[]) => setIssueLabels(...args),
}));
vi.mock("@/web/api/test-runs", () => ({ recordTestRun: vi.fn() }));
vi.mock("@/web/api/issue-attachments", () => ({
  deleteIssueAttachment: vi.fn(),
}));
vi.mock("@/web/api/knowledge", () => ({
  listTreeNodesQuery: () => ({
    queryKey: ["knowledge", "listTreeNodes", []],
    queryFn: async () => [],
  }),
}));

const { IssueDetailClient } = await import(
  "../web/routes/$locale/_app/-components/project/issue-detail-client"
);

const ISSUE_ID = "00000000-0000-4000-8000-0000000000a1";
const PROJECT = "00000000-0000-4000-8000-0000000000b1";
const ENV = "00000000-0000-4000-8000-0000000000e1";
const USER = "00000000-0000-4000-8000-0000000000f1";
const LABEL = "00000000-0000-4000-8000-0000000000c1";
const OTHER = "00000000-0000-4000-8000-0000000000d1";

const T0 = "2026-11-19T08:00:00.000Z";
const T1 = "2026-11-19T08:05:00.000Z";
const T2 = "2026-11-19T08:06:00.000Z";

function issueFixture(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: ISSUE_ID,
    number: 12,
    title: "Checkout total off by one",
    description: "Seen on staging",
    status: "open",
    priority: "medium",
    type: "bug",
    projectId: PROJECT,
    environmentId: null,
    assigneeId: null,
    parentId: null,
    jiraKey: null,
    createdAt: T0,
    updatedAt: T0,
    project: { id: PROJECT, name: "Storefront", key: "SHOP" },
    environment: null,
    assignee: null,
    createdBy: { id: USER, name: "Rina Hartono", image: null },
    comments: [],
    labels: [],
    parent: null,
    children: [],
    ...over,
  } as unknown as IssueDetail;
}

/** What updateIssue returns: the updated row with its new `updatedAt`. */
function saved(row: Partial<Record<string, unknown>>, updatedAt: string) {
  return {
    success: true,
    data: { ...issueFixture(), ...row, updatedAt },
  };
}

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
  updateIssue.mockReset();
  setIssueLabels.mockReset();
  setIssueLabels.mockResolvedValue({ success: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

type Props = React.ComponentProps<typeof IssueDetailClient>;

function ui(props: Partial<Props>) {
  return (
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <IssueDetailClient
          issue={issueFixture()}
          users={[{ id: USER, name: "Rina Hartono", image: null }]}
          environments={[{ id: ENV, name: "Staging" }]}
          siblings={[]}
          attachments={[]}
          testRuns={[]}
          allLabels={[{ id: LABEL, name: "regression", color: "#dc2626" }]}
          canEdit
          onReload={async () => issueFixture()}
          {...props}
        />
      </IntlProvider>
    </QueryClientProvider>
  );
}

async function mount(props: Partial<Props> = {}) {
  await act(async () => {
    root.render(ui(props));
  });
  if (props.canEdit !== false) {
    await vi.waitFor(() => {
      if (!document.querySelector(".ProseMirror")) throw new Error("no editor");
    });
  }
  await act(async () => {});
}

const titleInput = () =>
  document.querySelector('input[aria-label="Title"]') as HTMLInputElement;
const editorDom = () => document.querySelector(".ProseMirror") as HTMLElement;
const editor = () => (editorDom() as HTMLElement & { editor: Editor }).editor;
const sidebar = () =>
  document.querySelector('aside[aria-label="Properties"]') as HTMLElement;
const chipRow = () =>
  document.querySelector('[role="group"][aria-label="Properties"]') as
    | HTMLElement
    | undefined;
const text = () => document.body.textContent ?? "";

/** Text a screen reader gets (aria-hidden parts out). */
function spoken(el: Element) {
  const copy = el.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) {
    hidden.remove();
  }
  return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
}

async function typeTitle(value: string) {
  const input = titleInput();
  await act(async () => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function blurTitle() {
  await act(async () => {
    titleInput().blur();
  });
  await act(async () => {});
}

/** Replaces the description and leaves the editor, as a user would. */
async function editDescription(markdown: string) {
  await act(async () => {
    editor().commands.focus();
    editor().commands.setContent(markdown, { contentType: "markdown" });
  });
  await act(async () => {
    editor().commands.blur();
    editorDom().blur();
  });
  await act(async () => {});
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

const button = (name: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => spoken(b) === name
  ) as HTMLButtonElement | undefined;

describe("issue page layout", () => {
  it("has a main column and a properties sidebar from lg, a chip row below lg", async () => {
    await mount();
    const layout = document.querySelector(
      '[data-slot="issue-layout"]'
    ) as HTMLElement;
    expect(layout.className).toContain("lg:grid-cols-");
    expect(sidebar().className).toContain("hidden");
    expect(sidebar().className).toContain("lg:flex");
    expect(chipRow()?.className).toContain("lg:hidden");
    // Title and description sit in the main column, borderless.
    const main = document.querySelector('[data-slot="issue-main"]');
    expect(main?.contains(titleInput())).toBe(true);
    expect(main?.contains(editorDom())).toBe(true);
    expect(titleInput().className).not.toContain("border");
  });

  it("lists the properties in the sidebar with read-only dates", async () => {
    await mount();
    const rows = spoken(sidebar());
    for (const part of [
      "Status: Open",
      "Priority: Medium",
      "Assignee: Unassigned",
      "Type: Bug",
      "Labels: No labels",
      "Environment: None",
      "Created",
      "Updated",
    ]) {
      expect(rows).toContain(part);
    }
    // No parent and no candidates: no Parent row (as before).
    expect(rows).not.toContain("Parent");
    // The dates are text, not pickers.
    const created = sidebar().querySelector('[data-slot="issue-dates"]');
    expect(created?.querySelector("button")).toBeNull();
  });

  it("shows the Parent row when there are candidates", async () => {
    await mount({
      siblings: [{ id: OTHER, number: 3, title: "Checkout epic" }],
    });
    expect(spoken(sidebar())).toContain("Parent: No parent");
  });
});

describe("saving the title and description", () => {
  it("saves the title on blur with the updatedAt it saw, then shows Saved", async () => {
    updateIssue.mockResolvedValue(saved({ title: "Checkout total wrong" }, T1));
    await mount();
    await typeTitle("Checkout total wrong");
    await blurTitle();
    expect(updateIssue).toHaveBeenCalledWith(ISSUE_ID, {
      title: "Checkout total wrong",
      expectedUpdatedAt: T0,
    });
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-slot="save-status"][data-field="title"]')
          ?.textContent
      ).toBe("Saved")
    );
  });

  it("Enter in the title saves it", async () => {
    updateIssue.mockResolvedValue(saved({ title: "Refund email" }, T1));
    await mount();
    await typeTitle("Refund email");
    await act(async () => {
      titleInput().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    await act(async () => {});
    expect(updateIssue).toHaveBeenCalledTimes(1);
  });

  it("does not save when nothing changed", async () => {
    await mount();
    await act(async () => {
      titleInput().focus();
    });
    await blurTitle();
    await act(async () => {
      editor().commands.focus();
    });
    await act(async () => {
      editor().commands.blur();
      editorDom().blur();
    });
    await act(async () => {});
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it("saves the description on blur and sends the next updatedAt after each save", async () => {
    updateIssue
      .mockResolvedValueOnce(saved({ title: "Renamed" }, T1))
      .mockResolvedValueOnce(
        saved({ title: "Renamed", description: "Steps then result" }, T2)
      );
    await mount();
    await typeTitle("Renamed");
    await blurTitle();
    await editDescription("Steps then result");
    expect(updateIssue).toHaveBeenCalledTimes(2);
    expect(updateIssue.mock.calls[1]).toEqual([
      ISSUE_ID,
      { description: "Steps then result", expectedUpdatedAt: T1 },
    ]);
    await vi.waitFor(() =>
      expect(
        document.querySelector(
          '[data-slot="save-status"][data-field="description"]'
        )?.textContent
      ).toBe("Saved")
    );
  });

  it("takes updatedAt from a property change before the next text save", async () => {
    updateIssue
      .mockResolvedValueOnce(saved({ priority: "high" }, T1))
      .mockResolvedValueOnce(saved({ title: "After priority" }, T2));
    await mount();
    const trigger = Array.from(sidebar().querySelectorAll("button")).find((b) =>
      spoken(b).startsWith("Priority")
    ) as HTMLElement;
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
        document.querySelectorAll<HTMLElement>('[role="option"]')
      ).find((o) => (o.textContent ?? "").includes("High"));
      if (!found) throw new Error("no High option");
      return found;
    });
    await click(option);
    await vi.waitFor(() => expect(updateIssue).toHaveBeenCalledTimes(1));
    expect(updateIssue.mock.calls[0]).toEqual([ISSUE_ID, { priority: "high" }]);
    await typeTitle("After priority");
    await blurTitle();
    await vi.waitFor(() => expect(updateIssue).toHaveBeenCalledTimes(2));
    expect(updateIssue.mock.calls[1]?.[1]).toEqual({
      title: "After priority",
      expectedUpdatedAt: T1,
    });
  });

  it("adopts a refetched updatedAt only when the text is the one it edits", async () => {
    updateIssue.mockResolvedValue(saved({ title: "Edited" }, T2));
    await mount();
    // Someone changed a property: same text, newer updatedAt — safe to adopt.
    await act(async () => {
      root.render(
        ui({ issue: issueFixture({ status: "resolved", updatedAt: T1 }) })
      );
    });
    await typeTitle("Edited");
    await blurTitle();
    expect(updateIssue.mock.calls[0]?.[1]).toEqual({
      title: "Edited",
      expectedUpdatedAt: T1,
    });

    // Someone changed the description: not adopted, so the next description
    // save is refused (409) instead of overwriting theirs.
    await act(async () => {
      root.render(
        ui({
          issue: issueFixture({
            title: "Edited",
            description: "Rewritten by Bayu",
            updatedAt: "2026-11-19T08:09:00.000Z",
          }),
        })
      );
    });
    await editDescription("Mine");
    expect(updateIssue.mock.calls[1]?.[1]).toEqual({
      description: "Mine",
      expectedUpdatedAt: T2,
    });
  });

  it("shows a failed save inline with Retry", async () => {
    updateIssue
      .mockResolvedValueOnce({ success: false, message: "Failed to update" })
      .mockResolvedValueOnce(saved({ title: "Second try" }, T1));
    await mount();
    await typeTitle("Second try");
    await blurTitle();
    const status = () =>
      document.querySelector(
        '[data-slot="save-status"][data-field="title"]'
      ) as HTMLElement;
    await vi.waitFor(() => expect(status().textContent).toContain("Not saved"));
    // The text stays.
    expect(titleInput().value).toBe("Second try");
    const retry = status().querySelector("button") as HTMLButtonElement;
    await click(retry);
    await vi.waitFor(() => expect(updateIssue).toHaveBeenCalledTimes(2));
    expect(updateIssue.mock.calls[1]?.[1]).toEqual({
      title: "Second try",
      expectedUpdatedAt: T0,
    });
    await vi.waitFor(() => expect(status().textContent).toBe("Saved"));
  });

  it("on 409 keeps the user's text, offers Reload, and keeps it copyable after", async () => {
    updateIssue.mockResolvedValue({
      success: false,
      message: "Someone else changed this issue",
      code: "issueChanged",
    });
    const onReload = vi.fn(async () =>
      issueFixture({
        description: "Their version from Bayu",
        updatedAt: T2,
      })
    );
    await mount({ onReload });
    await editDescription("My careful repro steps");
    await vi.waitFor(() => expect(text()).toContain("Changed by someone else"));
    // Nothing discarded: the editor still holds the user's text.
    expect(editorDom().textContent).toContain("My careful repro steps");

    const reload = button("Reload") as HTMLButtonElement;
    expect(reload).toBeDefined();
    await click(reload);
    await vi.waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(editorDom().textContent).toContain("Their version from Bayu")
    );
    expect(text()).not.toContain("Changed by someone else");
    // The user's text is still on the page to copy.
    const kept = document.querySelector(
      '[data-slot="kept-text"] textarea'
    ) as HTMLTextAreaElement;
    expect(kept.value).toBe("My careful repro steps");
    expect(kept.readOnly).toBe(true);

    // The next save goes out against the reloaded version.
    updateIssue.mockResolvedValue(
      saved({ description: "Merged by hand" }, "2026-11-19T08:07:00.000Z")
    );
    await editDescription("Merged by hand");
    await vi.waitFor(() =>
      expect(updateIssue).toHaveBeenLastCalledWith(ISSUE_ID, {
        description: "Merged by hand",
        expectedUpdatedAt: T2,
      })
    );
  });
});

describe("without issue: write", () => {
  it("shows everything read-only: no pickers, no title field, no editor", async () => {
    await mount({ canEdit: false });
    expect(titleInput()).toBeNull();
    expect(editorDom()).toBeNull();
    expect(text()).toContain("Checkout total off by one");
    expect(text()).toContain("Seen on staging");
    expect(sidebar().querySelector("button")).toBeNull();
    expect(chipRow()?.querySelector("button")).toBeNull();
    expect(
      sidebar().querySelectorAll('[data-readonly=""]').length
    ).toBeGreaterThanOrEqual(6);
    expect(spoken(sidebar())).toContain("Status: Open");
    // Writes the server would refuse are not offered either.
    expect(button("Attach")).toBeUndefined();
    expect(button("Comment")).toBeUndefined();
  });
});
