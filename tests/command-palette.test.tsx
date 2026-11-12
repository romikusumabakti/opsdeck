// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const push = vi.hoisted(() => vi.fn());
const nav = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => nav.pathname,
}));
vi.mock("@/components/theme-provider", () => ({
  useTheme: () => ({ setTheme: vi.fn() }),
}));
vi.mock("@/components/accent-provider", () => ({
  useAccent: () => ({ setAccent: vi.fn() }),
}));
vi.mock("@/components/motif-provider", () => ({
  useMotif: () => ({ setPreference: vi.fn() }),
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: vi.fn() } }));
vi.mock("@/web/api/session", () => ({ resetSession: vi.fn() }));

import { CommandPalette } from "@/components/command-palette";
import type { OrgRole, ProjectRole } from "@/lib/permissions";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = "0197f3a0-1b2c-7def-8000-0123456789f1";
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function openPalette(orgRole: OrgRole, projectRole: ProjectRole) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <CommandPalette
          environments={[]}
          projects={[{ id: PROJECT, key: "KMEM", name: "KMEM" }]}
          orgRole={orgRole}
          projectRoles={{ [PROJECT]: projectRole }}
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

/** The palette items' labels. */
const labels = () =>
  [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].map(
    (el) => el.textContent ?? ""
  );

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  push.mockClear();
  nav.pathname = "/";
});

describe("command palette pages", () => {
  it("lists every gated page to an admin", async () => {
    // Admins are engineer on every project.
    await openPalette("admin", "engineer");
    expect(labels()).toEqual(
      expect.arrayContaining([
        messages.nav.storage,
        messages.nav.repositories,
        messages.nav.ci,
        messages.nav.cloudflare,
        messages.header.createEnvironment,
      ])
    );
  });

  it("opens each gated page at its path", async () => {
    await openPalette("admin", "engineer");
    // Choosing an item closes the palette, so each pick (re)opens it.
    const open = async (label: string) => {
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            `button[aria-label="${messages.commandPalette.triggerLabel}"]`
          )
          ?.click()
      );
      const el = [
        ...document.querySelectorAll<HTMLElement>("[cmdk-item]"),
      ].find((item) => item.textContent === label);
      await act(async () => el?.click());
    };
    await open(messages.nav.storage);
    await open(messages.nav.repositories);
    await open(messages.nav.ci);
    await open(messages.nav.cloudflare);
    expect(push.mock.calls.map(([path]) => path)).toEqual([
      "/storage",
      "/admin/repositories",
      "/admin/ci",
      "/admin/cloudflare",
    ]);
  });

  it("lists Servers and Storage to an engineer", async () => {
    await openPalette("engineer", "engineer");
    expect(labels()).toEqual(
      expect.arrayContaining([messages.userMenu.servers, messages.nav.storage])
    );
  });

  it("hides Servers and Storage from a QA member", async () => {
    await openPalette("qa", "qa");
    expect(labels()).not.toContain(messages.userMenu.servers);
    expect(labels()).not.toContain(messages.nav.storage);
  });

  it("hides Repositories, CI and Cloudflare from a QA member", async () => {
    await openPalette("qa", "qa");
    const shown = labels();
    for (const label of [
      messages.nav.repositories,
      messages.nav.ci,
      messages.nav.cloudflare,
      messages.nav.storage,
      messages.header.createEnvironment,
    ]) {
      expect(shown).not.toContain(label);
    }
  });
});

describe("command palette Variables entry", () => {
  it("offers Variables inside an environment to an engineer", async () => {
    nav.pathname = "/KMEM/dev-1/deploys";
    await openPalette("engineer", "engineer");
    const el = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
      (item) => item.textContent === messages.nav.variables
    );
    await act(async () => el?.click());
    expect(push).toHaveBeenCalledWith("/KMEM/dev-1/settings?tab=variables");
  });

  it("hides Variables from QA inside an environment", async () => {
    nav.pathname = "/KMEM/dev-1/deploys";
    await openPalette("qa", "qa");
    expect(labels()).not.toContain(messages.nav.variables);
  });

  it("hides Variables outside an environment", async () => {
    await openPalette("engineer", "engineer");
    expect(labels()).not.toContain(messages.nav.variables);
  });
});
