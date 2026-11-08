// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

vi.mock("@/hooks/use-unsaved-changes", () => ({ useUnsavedChanges: () => {} }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { listCiConnectionsQuery } from "@/web/api/ci-connections";
import { Route } from "../web/routes/$locale/_app/admin.ci.index";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const connection = (id: string, name: string) => ({
  id,
  name,
  provider: "woodpecker" as const,
  forge: "bitbucket" as const,
  baseUrl: `https://${name}.example.com`,
  hasApiToken: true,
  forgeUsername: "bot",
  hasForgeToken: true,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function renderPage(connections: ReturnType<typeof connection>[]) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(listCiConnectionsQuery().queryKey, connections);
  const Page = Route.options.component as React.ComponentType;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages}>
          <Page />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("/admin/ci", () => {
  it("renders the one connection's edit form directly, with no table", async () => {
    await renderPage([connection("c1", "woodpecker")]);
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("form")).not.toBeNull();
    expect(
      container.querySelector<HTMLInputElement>("input[name='baseUrl']")?.value
    ).toBe("https://woodpecker.example.com");
  });

  it("lists more than one connection in a table", async () => {
    await renderPage([connection("c1", "one"), connection("c2", "two")]);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(
      [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    ).toEqual(["/admin/ci/c1", "/admin/ci/c2"]);
  });
});
