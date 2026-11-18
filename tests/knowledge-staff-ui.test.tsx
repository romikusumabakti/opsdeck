// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const state = vi.hoisted(() => ({ role: "staff" }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Outlet: () => null,
}));
vi.mock("@/i18n/navigation", () => ({
  usePathname: () => "/knowledge",
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/web/api/session", () => ({
  useMe: () => ({ orgRole: state.role }),
}));
vi.mock("@/web/api/knowledge", () => ({
  listCollectionsQuery: () => ({
    queryKey: ["collections"],
    queryFn: async () => [],
  }),
  listTreeNodesQuery: () => ({ queryKey: ["nodes"], queryFn: async () => [] }),
  moveCollection: vi.fn(),
  moveDocument: vi.fn(),
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
  updateCollection: vi.fn(),
  deleteCollection: vi.fn(),
}));
vi.mock("@/components/knowledge-search", () => ({
  KnowledgeSearch: () => null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DocumentActions } from "@/components/document-actions";
import { Route as LayoutRoute } from "../web/routes/$locale/_app/knowledge.route";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const COLLECTION = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Handbook",
  description: null,
  rank: "a0",
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(["collections"], [COLLECTION]);
  queryClient.setQueryData(["nodes"], []);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages}>
          {ui}
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const hrefs = () =>
  [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));

describe("knowledge for a staff user", () => {
  it("shows no New document action in the layout", async () => {
    state.role = "staff";
    const Layout = LayoutRoute.options.component as React.ComponentType;
    await render(<Layout />);
    expect(container.textContent).toContain("Handbook");
    expect(hrefs()).not.toContain("/knowledge/new");
    expect(container.textContent).not.toContain(messages.knowledge.newDocument);
  });

  it("keeps New document for a QA", async () => {
    state.role = "qa";
    const Layout = LayoutRoute.options.component as React.ComponentType;
    await render(<Layout />);
    expect(hrefs()).toContain("/knowledge/new");
  });

  it("shows no Edit or History on a document without write rights", async () => {
    await render(
      <DocumentActions
        documentId="d1"
        slug="intro"
        canWrite={false}
        canDelete={false}
      />
    );
    expect(hrefs()).toEqual([]);
  });

  it("shows Edit and History to a writer", async () => {
    await render(
      <DocumentActions
        documentId="d1"
        slug="intro"
        canWrite
        canDelete={false}
      />
    );
    expect(hrefs()).toEqual([
      "/knowledge/intro/history",
      "/knowledge/intro/edit",
    ]);
  });
});
