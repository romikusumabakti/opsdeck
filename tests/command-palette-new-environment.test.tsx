// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const push = vi.hoisted(() => vi.fn());
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("next-themes", () => ({ useTheme: () => ({ setTheme: vi.fn() }) }));
vi.mock("@/components/accent-provider", () => ({
  useAccent: () => ({ setAccent: vi.fn() }),
}));
vi.mock("@/components/motif-provider", () => ({
  useMotif: () => ({ setPreference: vi.fn() }),
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));
vi.mock("@/web/api/session", () => ({ resetSession: vi.fn() }));

import { CommandPalette } from "@/components/command-palette";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = "0197f3a0-1b2c-7def-8000-0123456789f1";
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function openPalette(role: "engineer" | "qa") {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <CommandPalette
          environments={[]}
          projects={[{ id: PROJECT, key: "SCMB", name: "SCMB" }]}
          orgRole="member"
          projectRoles={{ [PROJECT]: role }}
        />
      </IntlProvider>
    );
  });
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(
        `button[aria-label="${messages.commandPalette.triggerLabel}"]`
      )
      ?.click()
  );
}

const item = (value: string) =>
  document.querySelector<HTMLElement>(`[cmdk-item][data-value="${value}"]`);

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  push.mockClear();
});

describe("command palette", () => {
  it("New environment goes to the projects list with the hint", async () => {
    await openPalette("engineer");
    await act(async () => item("new environment create")?.click());
    expect(push).toHaveBeenCalledWith("/projects?newEnvironment=1");
  });

  it("Projects goes to the plain projects list", async () => {
    await openPalette("engineer");
    await act(async () => item("projects environments")?.click());
    expect(push).toHaveBeenCalledWith("/projects");
  });

  it("offers New environment only to engineers", async () => {
    await openPalette("qa");
    expect(item("new environment create")).toBeNull();
  });
});
