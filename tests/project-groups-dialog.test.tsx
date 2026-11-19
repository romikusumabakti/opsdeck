// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

// The Projects header's "Manage groups" dialog: each action calls its
// endpoint and refetches the groups and the projects; refusals use the coded
// wording.

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  rename: vi.fn(),
  reorder: vi.fn(),
  merge: vi.fn(),
  remove: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/web/api/project-groups", () => ({
  listGroupsQuery: () => ({
    queryKey: ["project-groups", "listGroups", []],
    queryFn: api.list,
  }),
  createGroup: api.create,
  renameGroup: api.rename,
  reorderGroup: api.reorder,
  mergeGroups: api.merge,
  deleteGroup: api.remove,
}));

import { ProjectGroupsButton } from "@/components/project-groups-dialog";
import { ApiError } from "@/web/api/client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = messages.projectGroups;
const A = "0197f3a0-1b2c-7def-8000-0123456789a1";
const B = "0197f3a0-1b2c-7def-8000-0123456789a2";
const C = "0197f3a0-1b2c-7def-8000-0123456789a3";
const groups = [
  { id: A, name: "Banking", rank: "a", projectCount: 2 },
  { id: B, name: "Insurance", rank: "b", projectCount: 1 },
  { id: C, name: "Internal", rank: "c", projectCount: 0 },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;

const label = (text: string) =>
  document.querySelector<HTMLElement>(`[aria-label="${text}"]`);
const fill = (text: string) =>
  [...document.querySelectorAll("button")].findLast(
    (b) => b.textContent?.trim() === text
  );

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await settle();
}

async function type(el: HTMLInputElement | null, value: string) {
  expect(el).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(el, value);
    el?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openDialog() {
  await click(fill(t.manage));
  await settle();
}

beforeEach(async () => {
  api.list.mockResolvedValue(groups);
  for (const fn of [api.create, api.rename, api.reorder, api.merge, api.remove])
    fn.mockResolvedValue({});
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages}>
          <ProjectGroupsButton />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
  await openDialog();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("manage project groups", () => {
  it("lists the groups in order with their project counts", () => {
    const text = document.body.textContent ?? "";
    expect(text.indexOf("Banking")).toBeLessThan(text.indexOf("Insurance"));
    expect(text.indexOf("Insurance")).toBeLessThan(text.indexOf("Internal"));
    expect(text).toContain("2 projects");
    expect(text).toContain("1 project");
    expect(text).toContain("0 projects");
  });

  it("moves a group up before its neighbour and down after its neighbour", async () => {
    expect(label("Move Banking up")?.hasAttribute("disabled")).toBe(true);
    await click(label("Move Insurance up"));
    expect(api.reorder).toHaveBeenCalledWith(B, { before: A });
    await click(label("Move Insurance down"));
    expect(api.reorder).toHaveBeenCalledWith(B, { after: C });
  });

  it("renames inline", async () => {
    await click(label("Rename Banking"));
    await type(label(t.renameInput) as HTMLInputElement, "Finance");
    await click(fill(t.renameSave));
    expect(api.rename).toHaveBeenCalledWith(A, "Finance");
  });

  it("creates a group", async () => {
    await type(label(t.newName) as HTMLInputElement, "  Partners ");
    await click(fill(t.create));
    expect(api.create).toHaveBeenCalledWith("Partners");
  });

  it("deletes after a confirm that shows how many projects become ungrouped", async () => {
    await click(label("Delete Banking"));
    expect(document.body.textContent).toContain("2 projects become ungrouped.");
    expect(api.remove).not.toHaveBeenCalled();
    await click(fill(t.deleteAction));
    expect(api.remove).toHaveBeenCalledWith(A);
  });

  it("merges into a chosen group after a confirm that shows the count", async () => {
    await click(label("Merge Banking into…"));
    expect(document.body.textContent).toContain(
      '2 projects move from "Banking" to the chosen group'
    );
    expect(fill(t.mergeAction)?.hasAttribute("disabled")).toBe(true);
    await click(label(t.mergeTarget));
    const option = [...document.querySelectorAll("[role='option']")].find(
      (o) => o.textContent === "Insurance"
    );
    // The group being merged is not offered as its own target.
    expect(
      [...document.querySelectorAll("[role='option']")].some(
        (o) => o.textContent === "Banking"
      )
    ).toBe(false);
    await click(option);
    await click(fill(t.mergeAction));
    expect(api.merge).toHaveBeenCalledWith(A, B);
  });

  it("refetches the groups and the projects after an action", async () => {
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await click(label("Move Insurance up"));
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey?.[0]);
    expect(keys).toEqual(
      expect.arrayContaining(["project-groups", "project-catalog"])
    );
  });

  it("words a refusal from its code", async () => {
    api.create.mockRejectedValue(new ApiError(409, "taken", "groupNameTaken"));
    await type(label(t.newName) as HTMLInputElement, "banking");
    await click(fill(t.create));
    expect(api.toast.error).toHaveBeenCalledWith(
      messages.actionErrors.groupNameTaken
    );
  });
});
