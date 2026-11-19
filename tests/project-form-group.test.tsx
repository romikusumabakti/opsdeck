// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

// Project form: the Group select (searchable, "No group"), "Create group…"
// for admins only, and the groupId the form sends.

const api = vi.hoisted(() => ({
  addProject: vi.fn(),
  editProject: vi.fn(),
  createGroup: vi.fn(),
  orgRole: "admin",
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/hooks/use-unsaved-changes", () => ({ useUnsavedChanges: () => {} }));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/web/api/session", () => ({
  useMe: () => ({ orgRole: api.orgRole }),
}));
vi.mock("@/web/api/project-catalog", () => ({
  addProject: api.addProject,
  editProject: api.editProject,
}));
vi.mock("@/web/api/project-groups", () => ({
  listGroupsQuery: () => ({
    queryKey: ["project-groups", "listGroups", []],
    queryFn: async () => [
      { id: "0197f3a0-1b2c-7def-8000-0123456789a1", name: "Banking" },
      { id: "0197f3a0-1b2c-7def-8000-0123456789a2", name: "Insurance" },
    ],
  }),
  createGroup: api.createGroup,
}));

import { ProjectForm } from "@/components/project-form";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const BANKING = "0197f3a0-1b2c-7def-8000-0123456789a1";
const NEW_GROUP = "0197f3a0-1b2c-7def-8000-0123456789a9";
const t = messages.projectForm;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function renderForm(orgRole: string, groupId: string | null = null) {
  api.orgRole = orgRole;
  api.addProject.mockResolvedValue({ success: true, data: { id: "p" } });
  api.editProject.mockResolvedValue({ success: true, data: { id: "p" } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={messages}>
          <ProjectForm
            mode={{
              type: "edit",
              project: {
                id: "0197f3a0-1b2c-7def-8000-0123456789f1",
                key: "KMEM",
                name: "KMEM",
                description: null,
                groupId,
                defaultServerId: null,
              } as never,
            }}
          />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
  await settle();
}

const trigger = () =>
  container.querySelector<HTMLElement>("#project-group") as HTMLElement;
const options = () =>
  [...document.querySelectorAll("[role='option']")].map((o) => o.textContent);

async function openSelect() {
  await act(async () => trigger().click());
  await settle();
}

async function pick(text: string) {
  const option = [...document.querySelectorAll("[role='option']")].find(
    (o) => o.textContent === text
  ) as HTMLElement | undefined;
  expect(option).toBeDefined();
  await act(async () => option?.click());
  await settle();
}

async function submit() {
  await act(async () => container.querySelector("form")?.requestSubmit());
  await settle();
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("project form group", () => {
  it("lists No group and the groups, and sends the chosen groupId", async () => {
    await renderForm("admin");
    expect(trigger().textContent).toContain(t.groupNone);
    await openSelect();
    expect(options()).toEqual([
      t.groupNone,
      "Banking",
      "Insurance",
      t.groupCreate,
    ]);
    await pick("Banking");
    await submit();
    expect(api.editProject).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ groupId: BANKING })
    );
  });

  it("clears the group with No group", async () => {
    await renderForm("admin", BANKING);
    expect(trigger().textContent).toContain("Banking");
    await openSelect();
    await pick(t.groupNone);
    await submit();
    expect(api.editProject).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ groupId: null })
    );
  });

  it("does not offer Create group to a non-admin", async () => {
    await renderForm("engineer");
    await openSelect();
    expect(options()).toEqual([t.groupNone, "Banking", "Insurance"]);
  });

  it("creates a group and selects it", async () => {
    api.createGroup.mockResolvedValue({ id: NEW_GROUP, name: "Partners" });
    await renderForm("admin");
    await openSelect();
    await pick(t.groupCreate);
    const input = document.querySelector<HTMLInputElement>(
      `[aria-label="${t.groupCreateName}"]`
    );
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(input, "Partners");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const add = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === t.groupCreateAdd
    );
    await act(async () => add?.click());
    await settle();
    expect(api.createGroup).toHaveBeenCalledWith("Partners");
    expect(api.editProject).not.toHaveBeenCalled();
    await submit();
    expect(api.editProject).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ groupId: NEW_GROUP })
    );
  });
});
