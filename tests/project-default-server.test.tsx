// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

// Project settings, Details tab: the default server is a select of all
// servers for org server:manage, read-only text for everyone else, and only
// sent to editProject by those who may change it.

const api = vi.hoisted(() => ({ editProject: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-unsaved-changes", () => ({ useUnsavedChanges: () => {} }));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/web/api/project-catalog", () => ({
  addProject: vi.fn(),
  editProject: api.editProject,
}));

import { ProjectForm } from "@/components/project-form";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";
const SERVER_A = "0197f3a0-1b2c-7def-8000-0123456789c1";
const SERVER_B = "0197f3a0-1b2c-7def-8000-0123456789c2";
const project = {
  id: PROJECT_ID,
  key: "KMEM",
  name: "KMEM",
  client: null,
  description: null,
  defaultServerId: SERVER_A,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};
const servers = [
  { id: SERVER_A, name: "dev-56-129" },
  { id: SERVER_B, name: "dev-56-115" },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function renderForm(canChange: boolean) {
  api.editProject.mockResolvedValue({ success: true, data: project });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <ProjectForm
          mode={{ type: "edit", project: project as never }}
          defaultServer={{ servers, canChange }}
        />
      </IntlProvider>
    );
  });
}

async function submit() {
  await act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  api.editProject.mockReset();
});

describe("project default server", () => {
  it("is a select of all servers for server:manage, saved with the form", async () => {
    await renderForm(true);
    const trigger = container.querySelector<HTMLElement>("[role='combobox']");
    expect(trigger?.textContent).toContain("dev-56-129");
    await submit();
    expect(api.editProject).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ defaultServerId: SERVER_A })
    );
  });

  it("is read-only for anyone else and never sent", async () => {
    await renderForm(false);
    expect(container.querySelector("[role='combobox']")).toBeNull();
    expect(container.textContent).toContain("dev-56-129");
    expect(container.textContent).toContain(
      messages.projectForm.defaultServerAdminOnly
    );
    await submit();
    expect(api.editProject).toHaveBeenCalledTimes(1);
    expect(api.editProject.mock.calls[0]?.[1]).not.toHaveProperty(
      "defaultServerId"
    );
  });
});
