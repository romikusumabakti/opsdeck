// @vitest-environment happy-dom
import type * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentForm } from "@/components/document-form";
import { KnowledgeTree } from "@/components/knowledge-tree";
import messages from "../messages/en.json";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const api = vi.hoisted(() => ({
  updateCollection: vi.fn(),
  deleteCollection: vi.fn(),
  createDocument: vi.fn(),
}));

vi.mock("@/i18n/navigation", () => ({
  usePathname: () => "/knowledge",
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string | { to: string; search?: Record<string, string> };
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
  createDocument: api.createDocument,
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
  updateCollection: api.updateCollection,
  deleteCollection: api.deleteCollection,
}));
vi.mock("@/components/markdown-editor", () => ({
  MarkdownEditor: () => <div data-testid="editor" />,
}));
vi.mock("sonner", () => ({ toast: toastMock }));

const COL_A = "11111111-1111-4111-8111-111111111111";
const COL_B = "22222222-2222-4222-8222-222222222222";
const collections = [
  { id: COL_A, name: "Handbook", description: null, rank: "a0" },
  { id: COL_B, name: "Runbooks", description: null, rank: "a1" },
] as never[];
const nodes = [
  {
    id: "d1",
    collectionId: COL_A,
    parentId: null,
    title: "Intro",
    slug: "intro",
    rank: "a0",
    docType: "doc",
    publishedAt: null,
  },
] as never[];

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

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

const byLabel = (label: string) =>
  document.querySelector(`[aria-label="${label}"]`);
const itemByText = (text: string) =>
  Array.from(document.querySelectorAll('[role="menuitem"]')).find(
    (el) => el.textContent?.trim() === text
  );

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.updateCollection.mockReset();
  api.deleteCollection.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("collection header actions", () => {
  it("shows + and the actions menu to a manager", async () => {
    await render(
      <KnowledgeTree
        collections={collections}
        nodes={nodes}
        canManage
        canWrite
      />
    );
    const plus = byLabel("New document in Handbook");
    expect(plus?.getAttribute("href")).toBe(
      `/knowledge/new?collection=${COL_A}`
    );
    expect(byLabel("Actions for Handbook")).not.toBeNull();
    await click(byLabel("Actions for Handbook") as Element);
    expect(itemByText("Rename collection")).toBeDefined();
    expect(itemByText("Delete collection")).toBeDefined();
  });

  it("gives a writer the + but no menu", async () => {
    await render(
      <KnowledgeTree collections={collections} nodes={nodes} canWrite />
    );
    expect(byLabel("New document in Handbook")).not.toBeNull();
    expect(byLabel("Actions for Handbook")).toBeNull();
  });

  it("gives a reader neither", async () => {
    await render(<KnowledgeTree collections={collections} nodes={nodes} />);
    expect(byLabel("New document in Handbook")).toBeNull();
    expect(byLabel("Actions for Handbook")).toBeNull();
  });

  it("renames a collection", async () => {
    api.updateCollection.mockResolvedValue({ success: true });
    await render(
      <KnowledgeTree
        collections={collections}
        nodes={nodes}
        canManage
        canWrite
      />
    );
    await click(byLabel("Actions for Handbook") as Element);
    await click(itemByText("Rename collection") as Element);
    const input = document.querySelector(
      "#collection-rename-name"
    ) as HTMLInputElement;
    expect(input.value).toBe("Handbook");
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      set?.call(input, "Guides");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Save"
    ) as Element;
    await click(save);
    expect(api.updateCollection).toHaveBeenCalledWith(COL_A, {
      name: "Guides",
    });
  });

  it("warns with the document count and surfaces the server error on delete", async () => {
    api.deleteCollection.mockResolvedValue({
      success: false,
      message: "Failed to delete collection",
    });
    await render(
      <KnowledgeTree
        collections={collections}
        nodes={nodes}
        canManage
        canWrite
      />
    );
    await click(byLabel("Actions for Handbook") as Element);
    await click(itemByText("Delete collection") as Element);
    expect(document.body.textContent).toContain("and its 1 document");
    const confirm = Array.from(
      document.querySelectorAll('[role="alertdialog"] button')
    ).find((b) => b.textContent?.trim() === "Delete") as Element;
    await click(confirm);
    expect(api.deleteCollection).toHaveBeenCalledWith(COL_A);
    expect(toastMock.error).toHaveBeenCalledWith("Failed to delete collection");
  });

  it("uses the plain confirmation for an empty collection", async () => {
    await render(
      <KnowledgeTree
        collections={collections}
        nodes={nodes}
        canManage
        canWrite
      />
    );
    await click(byLabel("Actions for Runbooks") as Element);
    await click(itemByText("Delete collection") as Element);
    expect(document.body.textContent).toContain(
      'Delete the collection "Runbooks"? This cannot be undone.'
    );
  });
});

describe("document form collection picker", () => {
  it("is hidden in create mode", async () => {
    await render(
      <DocumentForm
        mode={{ type: "create", defaultCollectionId: COL_B }}
        collections={collections}
      />
    );
    expect(document.querySelector("#doc-collection")).toBeNull();
  });

  it("stays in edit mode", async () => {
    await render(
      <DocumentForm
        mode={{
          type: "edit",
          canDelete: false,
          document: {
            id: "d1",
            title: "Intro",
            content: "",
            collectionId: COL_A,
            publishedAt: null,
            docType: "doc",
          } as never,
        }}
        collections={collections}
      />
    );
    expect(document.querySelector("#doc-collection")).not.toBeNull();
  });
});

describe("new document page", () => {
  it("files into the chosen collection when ?collection= changes", async () => {
    const { NewDocumentView } = await import(
      "../web/routes/$locale/_app/knowledge.new"
    );
    api.createDocument.mockResolvedValue({
      success: true,
      data: { slug: "x" },
    });
    const view = (id: string) => (
      <NewDocumentView
        collections={collections}
        nodes={nodes}
        requestedCollectionId={id}
      />
    );
    await render(view(COL_A));
    expect(document.body.textContent).toContain("Handbook");
    await render(view(COL_B));
    expect(document.body.textContent).toContain("Runbooks");
    const title = document.querySelector("#doc-title") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(title, "Hello");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Save"
    ) as Element;
    await click(save);
    expect(api.createDocument.mock.calls[0]?.[0]?.collectionId).toBe(COL_B);
  });
});
