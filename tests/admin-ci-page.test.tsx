// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-unsaved-changes", () => ({ useUnsavedChanges: () => {} }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/web/api/ci-connections", () => ({
  listCiConnectionsQuery: () => ({
    queryKey: ["ci-connections", "listCiConnections"],
    queryFn: api.list,
  }),
  updateCiConnection: api.update,
  verifyCiConnection: api.verify,
}));

import { Route } from "../web/routes/$locale/_app/admin.ci.index";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const connection = (
  id: string,
  name: string,
  extra: Record<string, unknown> = {}
) => ({
  id,
  name,
  provider: "woodpecker" as const,
  forge: "bitbucket" as const,
  baseUrl: `https://${name}.example.com`,
  hasApiToken: true,
  forgeUsername: "bot",
  hasForgeToken: true,
  ...extra,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function renderPage(connections: ReturnType<typeof connection>[]) {
  api.list.mockResolvedValue(connections);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    ["ci-connections", "listCiConnections"],
    connections
  );
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

const input = (name: string) =>
  container.querySelector<HTMLInputElement>(`input[name='${name}']`);

const badges = () =>
  [...container.querySelectorAll("form span")]
    .map((el) => el.textContent ?? "")
    .filter((text) => text === "Set" || text === "Not set");

/** Types into a controlled input the way React sees it. */
async function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === label
  );

beforeEach(() => {
  api.list.mockReset();
  api.update.mockReset();
  api.verify.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("/admin/ci", () => {
  it("renders the one connection's edit form directly, with no table", async () => {
    await renderPage([connection("c1", "woodpecker")]);
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("form")).not.toBeNull();
    expect(input("baseUrl")?.value).toBe("https://woodpecker.example.com");
  });

  it("lists more than one connection in a table", async () => {
    await renderPage([connection("c1", "one"), connection("c2", "two")]);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(
      [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    ).toEqual(["/admin/ci/c1", "/admin/ci/c2"]);
  });

  it("after a save on the single card, the badges follow the server and the token field empties", async () => {
    await renderPage([connection("c1", "woodpecker", { hasApiToken: false })]);
    expect(badges()).toEqual(["Not set", "Set"]);
    const saved = connection("c1", "woodpecker", { hasApiToken: true });
    api.update.mockResolvedValue(saved);
    api.list.mockResolvedValue([saved]);

    const token = input("apiToken");
    if (!token) throw new Error("no API token field");
    await type(token, "new-token");
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
    });

    expect(api.update).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ apiToken: "new-token" })
    );
    expect(badges()).toEqual(["Set", "Set"]);
    expect(input("apiToken")?.value).toBe("");
    // Still the single card: no navigation away.
    expect(container.querySelector("form")).not.toBeNull();
  });

  it("Verify shows each check's outcome and reason", async () => {
    await renderPage([connection("c1", "woodpecker")]);
    api.verify.mockResolvedValue({
      ci: "ok",
      ciCode: null,
      forge: "failed",
      forgeCode: "forgeCredentialsRejected",
    });
    await act(async () => button(messages.ciForm.verify)?.click());
    expect(api.verify).toHaveBeenCalledWith("c1");
    const lines = [...container.querySelectorAll("li[data-status]")];
    expect(lines.map((li) => li.getAttribute("data-status"))).toEqual([
      "ok",
      "failed",
    ]);
    expect(lines[0]?.textContent).toContain(messages.ciForm.verifyOk);
    expect(lines[1]?.textContent).toContain(
      messages.ciForm.verifyCodes.forgeCredentialsRejected
    );
  });

  it("Verify reports forge credentials that are not configured", async () => {
    await renderPage([
      connection("c1", "woodpecker", { hasForgeToken: false }),
    ]);
    api.verify.mockResolvedValue({
      ci: "failed",
      ciCode: "ciTokenRejected",
      forge: "notConfigured",
      forgeCode: null,
    });
    await act(async () => button(messages.ciForm.verify)?.click());
    const lines = [...container.querySelectorAll("li[data-status]")];
    expect(lines[0]?.textContent).toContain(
      messages.ciForm.verifyCodes.ciTokenRejected
    );
    expect(lines[1]?.textContent).toContain(
      messages.ciForm.verifyNotConfigured
    );
  });
});
