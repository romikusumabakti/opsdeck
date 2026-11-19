// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isNotFound, isRedirect } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import arMessages from "../messages/ar.json";
import enMessages from "../messages/en.json";
import esMessages from "../messages/es.json";
import idMessages from "../messages/id.json";
import zhMessages from "../messages/zh.json";

// Storage per environment, browser side: the connection list and form with
// their permission-gated controls, Admin › Storage for the unassigned ones,
// and the removed global /storage URLs (no dead links).

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  test: vi.fn(),
  remove: vi.fn(),
  assign: vi.fn(),
  removeUnassigned: vi.fn(),
  confirmTyping: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock("@/components/dialog-provider", () => ({
  useDialog: () => ({ confirm: vi.fn(), confirmTyping: mocks.confirmTyping }),
}));
vi.mock("@/hooks/use-unsaved-changes", () => ({ useUnsavedChanges: vi.fn() }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/web/api/environment-storage", () => ({
  createEnvironmentStorage: mocks.create,
  updateEnvironmentStorage: mocks.update,
  testEnvironmentStorage: mocks.test,
  deleteEnvironmentStorage: mocks.remove,
}));
vi.mock("@/web/api/s3-connections", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assignS3Connection: mocks.assign,
  deleteUnassignedS3Connection: mocks.removeUnassigned,
}));

import { ApiError } from "@/web/api/client";
import { listEnvironmentsQuery } from "@/web/api/environments";
import { getS3ConnectionQuery } from "@/web/api/s3-connections";
import { meQuery } from "@/web/api/session";
import { UnassignedStorage } from "../web/routes/$locale/_app/-components/admin/storage/unassigned-storage";
import { StorageForm } from "../web/routes/$locale/_app/-components/env/storage/storage-form";
import { StorageList } from "../web/routes/$locale/_app/-components/env/storage/storage-list";
import { Route as EnvFiles } from "../web/routes/$locale/_app/$projectKey.$envSlug.storage.$connectionId.files";
import { Route as EnvNew } from "../web/routes/$locale/_app/$projectKey.$envSlug.storage.new";
import { Route as AdminStorage } from "../web/routes/$locale/_app/admin.storage";
import { Route as OldFiles } from "../web/routes/$locale/_app/storage.$id.files";
import { Route as OldConnection } from "../web/routes/$locale/_app/storage.$id.index";
import { Route as OldIndex } from "../web/routes/$locale/_app/storage.index";
import { Route as OldNew } from "../web/routes/$locale/_app/storage.new";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ENV_ID = "0197f3a0-1b2c-7def-8000-0000000000e1";
const CONN_ID = "0197f3a0-1b2c-7def-8000-0000000000c1";
const BASE = "/HMEM/dev/storage";

const connection = (over: Record<string, unknown> = {}) => ({
  id: CONN_ID,
  name: "assets",
  environmentId: ENV_ID,
  endpoint: "https://s3.example.com",
  region: "us-east-1",
  bucket: "assets",
  keyPrefix: "team-a/",
  accessKeyId: "AKIAEXAMPLE",
  forcePathStyle: true,
  hasSecret: true,
  isBackupDestination: false,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(ui: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={enMessages} timeZone="UTC">
          {ui}
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
});

const hrefs = () =>
  [...document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
const field = (id: string) =>
  document.getElementById(id) as HTMLInputElement | null;

async function type(id: string, value: string) {
  const el = field(id);
  if (!el) throw new Error(`no field ${id}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    container.querySelector("form")?.requestSubmit();
  });
}

describe("environment storage list", () => {
  const list = (props: { canManage: boolean; canBrowse: boolean }) => (
    <StorageList
      environmentId={ENV_ID}
      basePath={BASE}
      connections={[connection()]}
      {...props}
    />
  );

  it("an engineer browses and adds; the rows link to the environment's pages", async () => {
    await render(list({ canManage: true, canBrowse: true }));
    expect(hrefs()).toContain(`${BASE}/${CONN_ID}/files`);
    expect(container.textContent).toContain("assets/team-a/");
    // Header action lives on the page; the row menu holds edit/test/delete.
    expect(
      container.querySelector(
        `button[aria-label="${enMessages.common.openMenu}"]`
      )
    ).not.toBeNull();
  });

  it("hides Browse from a caller without variable read", async () => {
    await render(list({ canManage: false, canBrowse: false }));
    expect(hrefs().some((h) => h?.endsWith("/files"))).toBe(false);
  });

  it("the empty state offers Add only to a manager", async () => {
    await render(
      <StorageList
        environmentId={ENV_ID}
        basePath={BASE}
        connections={[]}
        canManage
        canBrowse
      />
    );
    expect(container.textContent).toContain(enMessages.storage.emptyTitle);
    expect(hrefs()).toContain(`${BASE}/new`);
    act(() => root.unmount());
    container.remove();
    await render(
      <StorageList
        environmentId={ENV_ID}
        basePath={BASE}
        connections={[]}
        canManage={false}
        canBrowse={false}
      />
    );
    expect(container.textContent).toContain(enMessages.storage.emptyReadOnly);
    expect(hrefs()).not.toContain(`${BASE}/new`);
  });
});

describe("environment storage form", () => {
  it("create needs a secret and sends the prefix", async () => {
    mocks.create.mockResolvedValue(connection());
    await render(<StorageForm environmentId={ENV_ID} basePath={BASE} />);
    await type("storage-name", "assets");
    await type("storage-endpoint", "https://s3.example.com");
    await type("storage-bucket", "assets");
    await type("storage-keyPrefix", "team-a/");
    await type("storage-accessKeyId", "AKIAEXAMPLE");
    await submit();
    expect(mocks.create).not.toHaveBeenCalled();
    await type("storage-secretKey", "s3cr3t");
    await submit();
    expect(mocks.create).toHaveBeenCalledWith(
      ENV_ID,
      expect.objectContaining({
        name: "assets",
        keyPrefix: "team-a/",
        secretKey: "s3cr3t",
      })
    );
    expect(mocks.push).toHaveBeenCalledWith(BASE);
  });

  it("edit keeps the stored secret: blank secret is not sent while the location is unchanged", async () => {
    mocks.update.mockResolvedValue(connection());
    await render(
      <StorageForm
        environmentId={ENV_ID}
        basePath={BASE}
        connection={connection() as never}
      />
    );
    expect(container.textContent).toContain(
      enMessages.s3Form.secretKeyKeepHint
    );
    await type("storage-name", "assets 2");
    await submit();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    const body = mocks.update.mock.calls[0]?.[2];
    expect(body).toMatchObject({ name: "assets 2" });
    expect(body).not.toHaveProperty("secretKey");
  });

  it.each([
    ["storage-endpoint", "https://other.example.com"],
    ["storage-bucket", "other"],
    ["storage-region", "eu-west-1"],
    ["storage-keyPrefix", "team-b/"],
    ["storage-accessKeyId", "AKIAOTHER"],
  ])("edit asks for the secret again when %s changes", async (id, value) => {
    await render(
      <StorageForm
        environmentId={ENV_ID}
        basePath={BASE}
        connection={connection() as never}
      />
    );
    await type(id, value);
    expect(container.textContent).toContain(
      enMessages.s3Form.secretKeyRequiredHint
    );
    await submit();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      enMessages.actionErrors.s3SecretRequiredForLocationChange
    );
    await type("storage-secretKey", "new-secret");
    await submit();
    expect(mocks.update).toHaveBeenCalledWith(
      ENV_ID,
      CONN_ID,
      expect.objectContaining({ secretKey: "new-secret" })
    );
  });

  it("a prefix written without its slash is the stored prefix, not a location change", async () => {
    await render(
      <StorageForm
        environmentId={ENV_ID}
        basePath={BASE}
        connection={connection() as never}
      />
    );
    await type("storage-keyPrefix", "team-a");
    expect(container.textContent).toContain(
      enMessages.s3Form.secretKeyKeepHint
    );
  });

  it("puts the server's coded refusal on the secret field", async () => {
    mocks.update.mockRejectedValue(
      new ApiError(
        400,
        "Enter the secret key again",
        "s3SecretRequiredForLocationChange"
      )
    );
    await render(
      <StorageForm
        environmentId={ENV_ID}
        basePath={BASE}
        connection={connection() as never}
      />
    );
    await type("storage-name", "renamed");
    await submit();
    expect(container.textContent).toContain("Enter the secret key again");
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("shows other refusals (409 backup overlap) as a toast and stays", async () => {
    mocks.update.mockRejectedValue(
      new ApiError(
        409,
        "holds the instance backups",
        "s3BackupDestinationOverlap"
      )
    );
    await render(
      <StorageForm
        environmentId={ENV_ID}
        basePath={BASE}
        connection={connection() as never}
      />
    );
    await type("storage-name", "renamed");
    await submit();
    expect(mocks.toastError).toHaveBeenCalledWith("holds the instance backups");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("Test connection probes with the connection id and reports the result", async () => {
    mocks.test.mockResolvedValue({ ok: false, message: "AccessDenied" });
    await render(
      <StorageForm
        environmentId={ENV_ID}
        basePath={BASE}
        connection={connection() as never}
      />
    );
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === enMessages.s3Form.testConnection
    );
    await act(async () => button?.click());
    expect(mocks.test).toHaveBeenCalledWith(
      ENV_ID,
      expect.objectContaining({ connectionId: CONN_ID, keyPrefix: "team-a/" })
    );
    expect(container.textContent).toContain("AccessDenied");
  });

  it("read-only shows the values with no test or save controls", async () => {
    await render(
      <StorageForm
        environmentId={ENV_ID}
        basePath={BASE}
        connection={connection() as never}
        readOnly
      />
    );
    expect(field("storage-bucket")?.value).toBe("assets");
    expect(field("storage-bucket")?.closest("fieldset")?.disabled).toBe(true);
    const labels = [...container.querySelectorAll("button")].map(
      (b) => b.textContent
    );
    expect(labels).not.toContain(enMessages.s3Form.testConnection);
    expect(labels).not.toContain(enMessages.s3Form.saveChanges);
  });
});

describe("Admin › Storage", () => {
  const options = [
    { value: ENV_ID, label: "Heron Membership / Dev" },
    { value: "e2", label: "Heron Membership / QA" },
  ];

  it("shows an empty state when every connection has an environment", async () => {
    await render(<UnassignedStorage connections={[]} environments={options} />);
    expect(container.textContent).toContain(enMessages.adminStorage.emptyTitle);
  });

  it("lists the unassigned connections", async () => {
    await render(
      <UnassignedStorage
        connections={[connection({ environmentId: null })]}
        environments={options}
      />
    );
    expect(container.textContent).toContain("assets");
    expect(container.textContent).toContain("https://s3.example.com");
  });

  it("guards the page with the org storage:manage right", () => {
    expect(AdminStorage.options.beforeLoad).toBeTypeOf("function");
  });
});

describe("environment storage page guards", () => {
  type Guard = (ctx: unknown) => unknown;
  const guard = (route: { options: { beforeLoad?: unknown } }, role: string) =>
    (route.options.beforeLoad as Guard)({ context: { role } });

  it("adding a connection is a 404 without environment update", () => {
    expect(() => guard(EnvNew, "viewer")).toThrow();
    try {
      guard(EnvNew, "qa");
    } catch (error) {
      expect(isNotFound(error)).toBe(true);
    }
    expect(() => guard(EnvNew, "engineer")).not.toThrow();
  });

  it("browsing is a 404 without variable read", () => {
    for (const role of ["viewer", "qa"]) {
      try {
        guard(EnvFiles, role);
        throw new Error("opened");
      } catch (error) {
        expect(isNotFound(error)).toBe(true);
      }
    }
    expect(() => guard(EnvFiles, "engineer")).not.toThrow();
  });
});

describe("removed global /storage URLs", () => {
  const OTHER_ENV = "0197f3a0-1b2c-7def-8000-0000000000e9";
  const environments = [
    { id: OTHER_ENV, key: "ZZZ", slug: "x" },
    { id: ENV_ID, key: "HMEM", slug: "dev" },
  ];

  /** A query client serving the caller's role, the lookup and the environments. */
  function context(orgRole: string, lookup: unknown | (() => never)) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(meQuery().queryKey, {
      id: "u1",
      orgRole,
    } as never);
    queryClient.setQueryData(
      listEnvironmentsQuery().queryKey,
      environments as never
    );
    if (typeof lookup === "function") {
      queryClient.query = (async (options: { queryKey: unknown }) => {
        if (JSON.stringify(options.queryKey).includes('getS3Connection"')) {
          return (lookup as () => never)();
        }
        return queryClient.fetchQuery(options as never);
      }) as never;
    } else {
      queryClient.setQueryData(
        getS3ConnectionQuery(CONN_ID).queryKey,
        lookup as never
      );
    }
    return { queryClient };
  }

  type Loader = (ctx: unknown) => unknown;
  async function outcome(
    route: { options: { beforeLoad?: unknown } },
    params: object,
    ctx: object
  ): Promise<string> {
    try {
      await (route.options.beforeLoad as Loader)({
        params: { locale: "en", ...params },
        context: ctx,
      });
    } catch (error) {
      if (isRedirect(error)) return String(error.options.href);
      if (isNotFound(error)) return "not-found";
      throw error;
    }
    return "no-redirect";
  }

  it("an assigned connection page goes to its environment's page", async () => {
    expect(
      await outcome(
        OldConnection,
        { id: CONN_ID },
        context("admin", connection())
      )
    ).toBe(`/en/HMEM/dev/storage/${CONN_ID}`);
  });

  it("an assigned connection's browser goes to the environment's browser", async () => {
    expect(
      await outcome(OldFiles, { id: CONN_ID }, context("infra", connection()))
    ).toBe(`/en/HMEM/dev/storage/${CONN_ID}/files`);
  });

  it("an unassigned connection goes to Admin › Storage for an admin", async () => {
    const ctx = context("admin", connection({ environmentId: null }));
    expect(await outcome(OldConnection, { id: CONN_ID }, ctx)).toBe(
      "/en/admin/storage"
    );
    expect(await outcome(OldFiles, { id: CONN_ID }, ctx)).toBe(
      "/en/admin/storage"
    );
  });

  it("an unassigned connection is not found for a role that cannot manage storage", async () => {
    for (const role of ["observer", "engineer"]) {
      expect(
        await outcome(
          OldConnection,
          { id: CONN_ID },
          context(role, connection({ environmentId: null }))
        )
      ).toBe("not-found");
    }
  });

  it("the instance backup bucket goes to Admin › Instance", async () => {
    expect(
      await outcome(
        OldConnection,
        { id: CONN_ID },
        context(
          "admin",
          connection({ environmentId: null, isBackupDestination: true })
        )
      )
    ).toBe("/en/admin/instance");
  });

  it("a missing connection, or one the caller cannot look up, is not found", async () => {
    expect(
      await outcome(OldConnection, { id: CONN_ID }, context("admin", null))
    ).toBe("not-found");
    const forbidden = context("engineer", () => {
      throw new ApiError(403, "Forbidden");
    });
    expect(await outcome(OldFiles, { id: CONN_ID }, forbidden)).toBe(
      "not-found"
    );
  });

  it("an assigned connection whose environment the caller cannot see is not found", async () => {
    expect(
      await outcome(
        OldConnection,
        { id: CONN_ID },
        context(
          "admin",
          connection({ environmentId: "0197f3a0-1b2c-7def-8000-0000000000ff" })
        )
      )
    ).toBe("not-found");
  });

  it("the old list and create URLs go to Admin › Storage for admins, else Home", async () => {
    for (const route of [OldIndex, OldNew]) {
      expect(await outcome(route, {}, context("admin", null))).toBe(
        "/en/admin/storage"
      );
      expect(await outcome(route, {}, context("engineer", null))).toBe("/en");
    }
  });
});

describe("storage messages", () => {
  const locales = {
    en: enMessages,
    id: idMessages,
    ar: arMessages,
    es: esMessages,
    zh: zhMessages,
  } as Record<string, Record<string, Record<string, unknown>>>;
  const namespaces = [
    "storage",
    "adminStorage",
    "s3Form",
    "newStorage",
    "editStorage",
  ];

  it.each(Object.keys(locales))(
    "%s has every key of the English storage namespaces",
    (locale) => {
      for (const ns of namespaces) {
        expect(Object.keys(locales[locale]?.[ns] ?? {}).sort()).toEqual(
          Object.keys(locales.en?.[ns] ?? {}).sort()
        );
      }
      expect(locales[locale]?.breadcrumbs?.storage).toBeTypeOf("string");
    }
  );
});
