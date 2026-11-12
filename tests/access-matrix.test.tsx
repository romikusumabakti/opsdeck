// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

// The Project access tab shows membership per project (yes/no); the job role
// lives in its own column, since it now decides the rights on every project.

vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/admin/users",
  useSearchParams: () => new URLSearchParams(),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import type { AccessMatrix as Matrix } from "@/web/api/access";
import { AccessMatrix } from "../web/routes/$locale/_app/-components/admin/users/access-matrix";
import type { UserRow } from "../web/routes/$locale/_app/-components/admin/users/types";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const P1 = { id: "p1", key: "ONE", name: "One" };
const P2 = { id: "p2", key: "TWO", name: "Two" };

function user(id: string, role: string): UserRow {
  return {
    id,
    name: `User ${id}`,
    email: `${id}@example.com`,
    image: null,
    role,
    banned: false,
    lastActiveAt: null,
  } as unknown as UserRow;
}

let root: Root | undefined;
let container: HTMLElement;

async function render(matrix: Matrix) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <IntlProvider locale="en" messages={messages}>
        <AccessMatrix
          users={[user("u1", "engineer"), user("u2", "observer")]}
          matrix={matrix}
          now={new Date("2026-11-12T00:00:00Z")}
          currentUserId="u1"
          toolbar={null}
        />
      </IntlProvider>
    );
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container.remove();
});

describe("AccessMatrix", () => {
  it("marks membership yes/no per project, not a role name", async () => {
    await render({ projects: [P1, P2], memberships: { u1: ["p1"] } });
    expect(container.querySelectorAll('[aria-label="Member"]')).toHaveLength(1);
    expect(
      container.querySelectorAll('[aria-label="Not a member"]')
    ).toHaveLength(3);
    expect(container.textContent).not.toMatch(/Viewer|Engineer · |QA ·/);
  });

  it("keeps the role column with the global role", async () => {
    await render({ projects: [P1], memberships: {} });
    expect(container.textContent).toContain("Observer");
  });
});
