// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBranding } from "@/i18n/branding";
import rawMessages from "../messages/en.json";

const messages = applyBranding(rawMessages, {
  appName: "Panel",
  allowedEmailDomain: "acme.test",
});

const api = vi.hoisted(() => ({
  inviteUser: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/web/api/users", () => ({ inviteUser: api.inviteUser }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { InviteDialog } from "../web/routes/$locale/_app/-components/admin/users/invite-dialog";
import type { UserRow } from "../web/routes/$locale/_app/-components/admin/users/types";
import type { UserActionHandlers } from "../web/routes/$locale/_app/-components/admin/users/use-user-actions";
import { RoleBadge } from "../web/routes/$locale/_app/-components/admin/users/user-badges";
import { UserRowActions } from "../web/routes/$locale/_app/-components/admin/users/user-row-actions";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const en = messages.users;
let container: HTMLDivElement | undefined;
let root: Root | undefined;

const user = (role: string) =>
  ({
    id: "u2",
    name: "Rina",
    email: "rina@acme.test",
    image: null,
    role,
    banned: false,
    lastActiveAt: null,
  }) as unknown as UserRow;

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  const mounted = createRoot(container);
  root = mounted;
  await act(async () => {
    mounted.render(
      <IntlProvider locale="en" messages={messages}>
        {node}
      </IntlProvider>
    );
  });
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("element not found");
  await act(async () => (el as HTMLElement).click());
  await settle();
}

const bodyText = () => document.body.textContent ?? "";
const byText = (selector: string, label: string) =>
  [...document.querySelectorAll(selector)].find((el) =>
    el.textContent?.includes(label)
  );

afterEach(async () => {
  const mounted = root;
  if (mounted) await act(async () => mounted.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("Change role submenu", () => {
  async function openRoleSubmenu(row: UserRow) {
    await mount(
      <UserRowActions
        user={row}
        isSelf={false}
        perms={{
          canRename: false,
          canSetRole: true,
          canOffboard: false,
          canDelete: false,
        }}
        actions={{ isPending: false } as unknown as UserActionHandlers}
      />
    );
    await click(document.querySelector('button[aria-label="Open menu"]'));
    await click(byText('[role="menuitem"]', en.roleChangeTitle));
  }

  it("offers the five roles, each with a one-line description", async () => {
    await openRoleSubmenu(user("qa"));
    for (const label of ["Admin", "Infra", "Engineer", "QA / BA", "Observer"]) {
      expect(bodyText()).toContain(label);
    }
    expect(bodyText()).toContain(en.roleDescription.engineer);
    expect(bodyText()).not.toContain("Member");
  });
});

describe("Invite dialog", () => {
  it("asks for the role on invite, with no default", async () => {
    await mount(
      <InviteDialog open onOpenChange={vi.fn()} applyOptimistic={vi.fn()} />
    );
    const trigger = document.querySelector("#invite-role");
    expect(trigger?.textContent).toContain(en.rolePlaceholder);

    const set = (id: string, value: string) => {
      const el = document.querySelector<HTMLInputElement>(id);
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(el, value);
      el?.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      set("#invite-name", "New");
      set("#invite-email", "new@acme.test");
    });
    await act(async () => {
      document
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
    });
    await settle();

    expect(api.inviteUser).not.toHaveBeenCalled();
    expect(bodyText()).toContain(messages.common.required);
  });
});

describe("RoleBadge", () => {
  it("shows a legacy member value as the floored QA label", async () => {
    await mount(<RoleBadge {...{ role: "member" }} />);
    expect(container?.textContent).toBe(en.role.qa);
  });

  it("shows a known role by its label", async () => {
    await mount(<RoleBadge {...{ role: "observer" }} />);
    expect(container?.textContent).toBe(en.role.observer);
  });
});
