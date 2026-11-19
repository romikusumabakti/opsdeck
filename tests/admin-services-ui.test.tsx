// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

// Admin › Services: the list's search and repository filter, a service
// page's Add environment link, and Register service(s) from a repository.

const CONN = "0197f3a0-1b2c-7def-8000-0123456789c1";

const api = vi.hoisted(() => ({
  registerServices: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: api.push }),
}));
vi.mock("@/web/api/ci-connections", () => ({
  ciConnectionOptionsQuery: () => ({
    queryKey: ["ci-options"],
    queryFn: async () => [
      { id: CONN, name: "Woodpecker", forge: "bitbucket", hasForgeToken: true },
    ],
  }),
  registrableReposQuery: (id: string | null) => ({
    queryKey: ["ci-repos", id],
    queryFn: async () => [
      {
        ciRepoId: "7",
        fullName: "acme/kestrel-api",
        forgeRemoteId: "{kestrel}",
        active: true,
        linkedComponentKey: null,
      },
      {
        ciRepoId: "8",
        fullName: "acme/docs",
        forgeRemoteId: "{docs}",
        active: true,
        linkedComponentKey: "docs-site",
      },
    ],
    enabled: id !== null,
  }),
}));
vi.mock("@/web/api/service-catalog", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listServicesQuery: () => ({
    queryKey: ["services"],
    queryFn: async () => [{ key: "kestrel-api" }],
  }),
  registerServices: api.registerServices,
}));

const { filterServices, servicesSearch } = await import(
  "../web/routes/$locale/_app/admin.services.index"
);
const { addEnvironmentHref } = await import(
  "../web/routes/$locale/_app/admin.services.$serviceKey"
);
const { RegisterServicesDialog, suggestServiceKey } = await import(
  "../web/routes/$locale/_app/-components/services/register-services-dialog"
);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = messages.serviceCatalog;

const SERVICES = [
  { key: "core-backend", repoFullName: "acme/core" },
  { key: "core-web", repoFullName: "acme/core-web" },
  { key: "docs-site", repoFullName: "acme/docs" },
];

describe("the Services list", () => {
  it("reads ?repo= once or repeated", () => {
    expect(servicesSearch({})).toEqual({});
    expect(servicesSearch({ repo: "acme/core" })).toEqual({
      repo: ["acme/core"],
    });
    expect(
      servicesSearch({ repo: ["acme/core", "acme/core-web", ""] })
    ).toEqual({ repo: ["acme/core", "acme/core-web"] });
  });

  it("filters by key or repository text and by repositories", () => {
    expect(filterServices(SERVICES, "", []).map((s) => s.key)).toEqual([
      "core-backend",
      "core-web",
      "docs-site",
    ]);
    expect(filterServices(SERVICES, "WEB", []).map((s) => s.key)).toEqual([
      "core-web",
    ]);
    expect(filterServices(SERVICES, "acme/docs", []).map((s) => s.key)).toEqual(
      ["docs-site"]
    );
    expect(
      filterServices(SERVICES, "", ["acme/core", "acme/core-web"]).map(
        (s) => s.key
      )
    ).toEqual(["core-backend", "core-web"]);
    expect(filterServices(SERVICES, "docs", ["acme/core"])).toEqual([]);
  });
});

describe("a service's Add environment", () => {
  it("opens the one project's New environment with the service", () => {
    expect(
      addEnvironmentHref({
        key: "core-web",
        projects: [{ id: "p", key: "KES", name: "Kestrel" }],
      })
    ).toBe("/KES/environments/new?service=core-web");
  });

  it("goes to the projects list for none or several", () => {
    expect(addEnvironmentHref({ key: "core-web", projects: [] })).toBe(
      "/projects?newEnvironment=1"
    );
  });
});

describe("suggestServiceKey", () => {
  it("takes the repository's name, past the taken keys", () => {
    expect(suggestServiceKey("acme/Kestrel API", new Set())).toBe(
      "kestrel-api"
    );
    expect(suggestServiceKey("acme/docs", new Set(["docs"]))).toBe("docs-2");
    expect(suggestServiceKey("acme/docs", new Set(["docs", "docs-2"]))).toBe(
      "docs-3"
    );
  });
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(onOpenChange = vi.fn()) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <RegisterServicesDialog open onOpenChange={onOpenChange} />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
  await flush();
  return onOpenChange;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
  await flush();
}
const option = (text: string) =>
  [...document.querySelectorAll('[role="option"]')].find((o) =>
    o.textContent?.includes(text)
  );
const button = (text: string) =>
  [...document.querySelectorAll("button")].findLast(
    (b) => b.textContent?.trim() === text
  );
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Register service(s)", () => {
  it("registers a repository's services, keys suggested past the taken ones", async () => {
    api.registerServices.mockResolvedValue({
      services: [{ key: "kestrel-api-2" }, { key: "kestrel-worker" }],
      pipelineFileFailures: [],
    });
    const onOpenChange = await render();
    // The only connection is preselected; pick the repository.
    await click(document.getElementById("register-repository"));
    await click(option("acme/kestrel-api"));
    const key0 = document.getElementById("register-key-0") as HTMLInputElement;
    // kestrel-api is taken: the suggestion moves on.
    expect(key0.value).toBe("kestrel-api-2");
    await click(button(t.addService));
    const key1 = document.getElementById("register-key-1") as HTMLInputElement;
    await act(async () => type(key1, "kestrel-worker"));
    await flush();
    await act(async () => {
      document.querySelector("form")?.requestSubmit();
    });
    await flush();
    expect(api.registerServices).toHaveBeenCalledWith({
      services: [
        {
          componentKey: "kestrel-api-2",
          ciConnectionId: CONN,
          forgeRemoteId: "{kestrel}",
          bundleImage: "kestrel-api-2-deploy",
          pipelineMode: "custom",
        },
        {
          componentKey: "kestrel-worker",
          ciConnectionId: CONN,
          forgeRemoteId: "{kestrel}",
          bundleImage: "kestrel-worker-deploy",
          pipelineMode: "custom",
        },
      ],
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Several services: the list stays where it is.
    expect(api.push).not.toHaveBeenCalled();
  });

  it("refuses a taken key before asking the server", async () => {
    await render();
    await click(document.getElementById("register-repository"));
    await click(option("acme/kestrel-api"));
    const key0 = document.getElementById("register-key-0") as HTMLInputElement;
    await act(async () => type(key0, "kestrel-api"));
    await flush();
    await act(async () => {
      document.querySelector("form")?.requestSubmit();
    });
    await flush();
    expect(api.registerServices).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(t.keyTaken);
  });

  it("says a repository already builds a service, and opens a single new one", async () => {
    api.registerServices.mockResolvedValue({
      services: [{ key: "docs-search" }],
      pipelineFileFailures: [],
    });
    await render();
    await click(document.getElementById("register-repository"));
    await click(option("acme/docs"));
    expect(document.body.textContent).toContain(
      t.repoHasService.replace("{service}", "docs-site")
    );
    const key0 = document.getElementById("register-key-0") as HTMLInputElement;
    await act(async () => type(key0, "docs-search"));
    await flush();
    await act(async () => {
      document.querySelector("form")?.requestSubmit();
    });
    await flush();
    expect(api.push).toHaveBeenCalledWith("/admin/services/docs-search");
  });
});
