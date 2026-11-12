// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const api = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/web/api/servers", () => ({
  createServer: api.createServer,
  reinstallServerKey: vi.fn(),
  testServerConnection: vi.fn(),
  updateServer: vi.fn(),
}));
vi.mock("@/web/api/instance", () => ({
  getInstanceSshKeyQuery: () => ({
    queryKey: ["ssh-key"],
    queryFn: async () => ({ publicKey: "ssh-ed25519 AAAA" }),
  }),
  getAuthorizedKeysLineQuery: (from: string) => ({
    queryKey: ["akl", from],
    queryFn: async () => ({ command: "echo" }),
  }),
}));

import { ServerForm } from "@/components/server-form";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function renderForm() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ServerForm mode={{ type: "create" }} />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

async function submit() {
  await act(async () => {
    document
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function input(name: string) {
  return document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
}

describe("server form on shadcn field", () => {
  it("marks empty required fields invalid and announces the message", async () => {
    await renderForm();
    await submit();
    for (const name of ["name", "host", "username"]) {
      const el = input(name);
      expect(el?.getAttribute("aria-invalid")).toBe("true");
      const fieldEl = el?.closest('[data-slot="field"]');
      expect(fieldEl?.getAttribute("data-invalid")).toBe("true");
      expect(fieldEl?.querySelector('[role="alert"]')?.textContent).toBe(
        messages.common.required
      );
    }
    expect(document.querySelector('[data-slot="form-item"]')).toBeNull();
  });

  it("shows the password field with a matching label after switching method", async () => {
    await renderForm();
    expect(input("password")).toBeNull();
    await act(async () => {
      document
        .querySelector<HTMLElement>('[id="method-passwordOnce"]')
        ?.click();
    });
    const password = input("password");
    expect(password).not.toBeNull();
    const label = document.querySelector(`label[for="${password?.id}"]`);
    expect(password?.id).not.toBe("");
    expect(label?.textContent).toBe(messages.serverForm.passwordOnce);
  });

  it("rejects an sftpRoot without a leading slash", async () => {
    await renderForm();
    const root_ = input("sftpRoot");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(root_, "srv");
      root_?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await submit();
    const fieldEl = input("sftpRoot")?.closest('[data-slot="field"]');
    expect(fieldEl?.querySelector('[role="alert"]')?.textContent).toBe(
      messages.serverForm.sftpRootInvalid
    );
  });

  it("wires the placement label and aria-invalid to the Select trigger", async () => {
    await renderForm();
    const trigger = document.querySelector<HTMLElement>(
      '[data-slot="select-trigger"]'
    );
    expect(trigger?.id).not.toBe("");
    const label = document.querySelector(`label[for="${trigger?.id}"]`);
    expect(label?.textContent).toBe(messages.serverForm.placement);
    expect(trigger?.getAttribute("aria-invalid")).toBe("false");
  });
});
