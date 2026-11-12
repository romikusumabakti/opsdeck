// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

vi.mock("@/lib/auth-client", () => ({
  authClient: { signIn: { email: vi.fn(), passkey: vi.fn(), social: vi.fn() } },
  isPasskeySupported: () => false,
  isPasskeyAutofillSupported: async () => false,
}));
vi.mock("@/web/api/session", () => ({ resetSession: vi.fn() }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: vi.fn() }),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { SignInForm } from "../web/routes/$locale/-components/sign-in-form";

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

async function submitEmpty() {
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <SignInForm />
      </IntlProvider>
    );
  });
  await act(async () => {
    document
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("sign-in form on shadcn field", () => {
  it("marks each empty required field invalid and announces its message", async () => {
    await submitEmpty();
    const expected = {
      email: messages.common.emailInvalid,
      password: messages.common.required,
    };
    for (const [name, message] of Object.entries(expected)) {
      const input = document.querySelector<HTMLInputElement>(
        `input[name="${name}"]`
      );
      expect(input?.getAttribute("aria-invalid")).toBe("true");
      const fieldEl = input?.closest('[data-slot="field"]');
      expect(fieldEl?.getAttribute("data-invalid")).toBe("true");
      expect(fieldEl?.querySelector('[role="alert"]')?.textContent).toBe(
        message
      );
    }
  });

  it("points every label at an input id", async () => {
    await submitEmpty();
    const labels = [...document.querySelectorAll("label[for]")];
    expect(labels.length).toBeGreaterThanOrEqual(2);
    for (const label of labels) {
      const target = document.getElementById(label.getAttribute("for") ?? "");
      expect(target?.tagName).toBe("INPUT");
    }
  });

  it("no longer renders the legacy form-item wrapper", async () => {
    await submitEmpty();
    expect(document.querySelector('[data-slot="form-item"]')).toBeNull();
  });
});
