// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

// Fill from template when the environment's services define a name
// differently: the page lists each conflict with its definitions, the user
// picks one per variable, and the second fill sends those choices.

const ENV = "0197f3a0-1b2c-7def-8000-0123456789e1";
const ENGINEER = "engineer" as const;

const api = vi.hoisted(() => ({
  applyVariableTemplate: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/web/api/session", () => ({
  useMe: () => ({ orgRole: "engineer" }),
}));
vi.mock("@/web/api/variables", () => ({
  previewEnvFile: vi.fn(),
  setEnvFileManaged: vi.fn(),
  previewTextImport: vi.fn(),
  readServerImport: vi.fn(),
  saveImport: vi.fn(),
  applyVariableTemplate: api.applyVariableTemplate,
  deleteVariable: vi.fn(),
  regenerateVariable: vi.fn(),
  revealVariables: vi.fn(),
  putVariable: vi.fn(),
}));

import { DialogProvider } from "@/components/dialog-provider";
import { ProjectRoleProvider } from "@/components/project-role";
import { VariablesClient } from "../web/routes/$locale/_app/-components/env/variables/variables-client";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = messages.variables;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <DialogProvider>
            <ProjectRoleProvider role={ENGINEER}>
              <VariablesClient
                environmentId={ENV}
                listing={{
                  envFileManaged: false,
                  hasServices: true,
                  variables: [],
                }}
              />
            </ProjectRoleProvider>
          </DialogProvider>
        </IntlProvider>
      </QueryClientProvider>
    );
  });
  await flush();
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

const body = () => document.body.textContent ?? "";
const button = (text: string) =>
  [...document.querySelectorAll("button")].findLast(
    (b) => b.textContent?.trim() === text
  );
async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await flush();
}

const CONFLICT = {
  name: "MAIL_FROM",
  required: true,
  options: [
    {
      componentKeys: ["cms-web"],
      kind: "plain",
      defaultValue: "cms@example.com",
    },
    { componentKeys: ["core-backend"], kind: "secret", defaultValue: null },
  ],
};

describe("Fill from template conflicts", () => {
  it("asks per variable, says the strict flags stay, and sends the choices", async () => {
    api.applyVariableTemplate
      .mockResolvedValueOnce({
        added: ["APP_URL"],
        missing: ["MAIL_FROM"],
        conflicts: [CONFLICT],
      })
      .mockResolvedValueOnce({
        added: ["MAIL_FROM"],
        missing: [],
        conflicts: [],
      });
    await render();
    await click(button(t.applyTemplate));
    expect(api.applyVariableTemplate).toHaveBeenCalledWith(ENV);

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(t.conflicts.title);
    expect(dialog?.textContent).toContain(t.conflicts.escrowNote);
    expect(dialog?.textContent).toContain("MAIL_FROM");
    expect(dialog?.textContent).toContain("cms@example.com");
    expect(dialog?.textContent).toContain("core-backend");

    const fill = button(t.conflicts.fill) as HTMLButtonElement;
    expect(fill.disabled).toBe(true);
    const radio = [...document.querySelectorAll('[role="radio"]')].find((r) =>
      r.closest("label")?.textContent?.includes("core-backend")
    );
    await click(radio);
    expect(fill.disabled).toBe(false);
    await click(fill);
    expect(api.applyVariableTemplate).toHaveBeenLastCalledWith(ENV, {
      MAIL_FROM: "core-backend",
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(body()).not.toContain(t.conflicts.title);
  });

  it("fills without asking when nothing conflicts", async () => {
    api.applyVariableTemplate.mockResolvedValueOnce({
      added: ["APP_URL"],
      missing: [],
      conflicts: [],
    });
    await render();
    await click(button(t.applyTemplate));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(api.toast.success).toHaveBeenCalled();
  });
});
