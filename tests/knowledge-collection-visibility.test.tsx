// @vitest-environment happy-dom
import type * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollectionCreateDialog } from "@/components/collection-create-dialog";
import { KnowledgeTree } from "@/components/knowledge-tree";
import { ORG_ROLES } from "@/lib/permissions";
import messages from "../messages/en.json";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const api = vi.hoisted(() => ({
  createCollection: vi.fn(),
  updateCollection: vi.fn(),
}));

vi.mock("@/i18n/navigation", () => ({
  usePathname: () => "/knowledge",
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string | { to: string };
    children?: React.ReactNode;
  }) => (
    <a href={typeof href === "string" ? href : href.to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/web/api/knowledge", () => ({
  moveCollection: vi.fn(),
  moveDocument: vi.fn(),
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
  deleteCollection: vi.fn(),
  createCollection: api.createCollection,
  updateCollection: api.updateCollection,
}));
vi.mock("sonner", () => ({ toast: toastMock }));

const COL_A = "11111111-1111-4111-8111-111111111111";
const COL_B = "22222222-2222-4222-8222-222222222222";
const LOCK_LABEL = "Visible to selected roles only";
const pickable = ORG_ROLES.filter((r) => r !== "admin");

let container: HTMLDivElement;
let root: Root;

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}
async function render(ui: React.ReactElement) {
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages}>
        {ui}
      </IntlProvider>
    );
  });
  await settle();
}
async function click(el: Element | null | undefined) {
  if (!el) throw new Error("element not found");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}
const byLabel = (label: string) =>
  document.querySelector(`[aria-label="${label}"]`);
const byText = (selector: string, text: string) =>
  Array.from(document.querySelectorAll(selector)).find(
    (el) => el.textContent?.trim() === text
  );
// The radio is the control labelled by that label.
const radio = (label: string) => {
  const id = byText("label", label)?.id;
  return id
    ? document.querySelector(`[role=radio][aria-labelledby="${id}"]`)
    : null;
};
const roleBoxes = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      "[data-testid=visibility-roles] [role=checkbox]"
    )
  );
const saveButton = () =>
  byText("button", "Save") as HTMLButtonElement | undefined;

async function typeName(value: string) {
  const input = document.querySelector<HTMLInputElement>("#collection-name");
  if (!input) throw new Error("name input missing");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openCreate() {
  await render(<CollectionCreateDialog />);
  await click(byLabel("New collection"));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.createCollection.mockReset();
  api.updateCollection.mockReset();
  api.createCollection.mockResolvedValue({ success: true });
  api.updateCollection.mockResolvedValue({ success: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("collection visibility in the create dialog", () => {
  it("defaults to everyone, with the admin note and no role list", async () => {
    await openCreate();
    expect(radio("Everyone")?.hasAttribute("data-checked")).toBe(true);
    expect(roleBoxes()).toHaveLength(0);
    expect(document.body.textContent).toContain(
      "Admins always see every collection."
    );
    await typeName("Handbook");
    await click(saveButton());
    expect(api.createCollection).toHaveBeenCalledWith({
      name: "Handbook",
      description: null,
      visibleToRoles: [],
    });
  });

  it("lists every role but admin in global order once restricted", async () => {
    await openCreate();
    await click(radio("Only selected roles"));
    expect(roleBoxes().map((b) => b.getAttribute("data-role"))).toEqual(
      pickable
    );
    expect(
      roleBoxes().map((b) => b.closest("[data-slot=field]")?.textContent)
    ).toEqual(pickable.map((r) => messages.users.role[r]));
  });

  it("blocks Save with an inline message while no role is checked", async () => {
    await openCreate();
    await typeName("Handbook");
    await click(radio("Only selected roles"));
    expect(document.body.textContent).toContain("Pick at least one role");
    expect(saveButton()?.disabled).toBe(true);
    await click(roleBoxes()[0]);
    expect(document.body.textContent).not.toContain("Pick at least one role");
    expect(saveButton()?.disabled).toBe(false);
    await click(roleBoxes()[0]);
    expect(saveButton()?.disabled).toBe(true);
  });

  it("sends the checked roles", async () => {
    await openCreate();
    await typeName("Runbooks");
    await click(radio("Only selected roles"));
    await click(roleBoxes()[0]);
    await click(roleBoxes()[2]);
    await click(saveButton());
    expect(api.createCollection).toHaveBeenCalledWith({
      name: "Runbooks",
      description: null,
      visibleToRoles: [pickable[0], pickable[2]],
    });
  });

  it("sends an empty list when switched back to everyone", async () => {
    await openCreate();
    await typeName("Runbooks");
    await click(radio("Only selected roles"));
    await click(roleBoxes()[0]);
    await click(radio("Everyone"));
    await click(saveButton());
    expect(api.createCollection).toHaveBeenCalledWith(
      expect.objectContaining({ visibleToRoles: [] })
    );
  });
});

describe("collection visibility in the tree", () => {
  const collections = [
    {
      id: COL_A,
      name: "Handbook",
      description: null,
      rank: "a0",
      restricted: false,
      visibleToRoles: [],
    },
    {
      id: COL_B,
      name: "Runbooks",
      description: null,
      rank: "a1",
      restricted: true,
      visibleToRoles: ["infra"],
    },
  ] as never[];

  it("marks restricted collections with a labelled lock", async () => {
    await render(<KnowledgeTree collections={collections} nodes={[]} />);
    expect(
      document.querySelectorAll(`[aria-label="${LOCK_LABEL}"]`)
    ).toHaveLength(1);
    const lock = byLabel(LOCK_LABEL);
    expect(lock?.closest("[aria-expanded]")?.textContent).toContain("Runbooks");
  });

  it("shows a non-manager the lock only, never the roles", async () => {
    const viewerView = [
      { ...(collections[1] as unknown as object), visibleToRoles: undefined },
    ] as never[];
    await render(<KnowledgeTree collections={viewerView} nodes={[]} />);
    expect(byLabel(LOCK_LABEL)).not.toBeNull();
    expect(byLabel("Actions for Runbooks")).toBeNull();
    expect(document.body.textContent).not.toContain("Infra");
  });

  it("edits a collection's visibility from the actions menu", async () => {
    await render(
      <KnowledgeTree collections={collections} nodes={[]} canManage />
    );
    await click(byLabel("Actions for Runbooks"));
    await click(byText("[role=menuitem]", "Edit collection"));
    expect(radio("Only selected roles")?.hasAttribute("data-checked")).toBe(
      true
    );
    const checked = roleBoxes()
      .filter((b) => b.getAttribute("aria-checked") === "true")
      .map((b) => b.getAttribute("data-role"));
    expect(checked).toEqual(["infra"]);
    await click(radio("Everyone"));
    await click(saveButton());
    expect(api.updateCollection).toHaveBeenCalledWith(COL_B, {
      name: "Runbooks",
      visibleToRoles: [],
    });
  });
});
