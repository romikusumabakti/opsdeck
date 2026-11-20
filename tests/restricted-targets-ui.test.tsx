// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

// The browser side of restricted targets: the page guard for a terminal or
// file page take the org role alone on an infra-only server; an
// environment's storage list offers nothing on the instance backup bucket.

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/dialog-provider", () => ({
  useDialog: () => ({ confirm: vi.fn(), confirmTyping: vi.fn() }),
}));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/storage",
  useSearchParams: () => new URLSearchParams(),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/web/api/environment-storage", () => ({
  deleteEnvironmentStorage: vi.fn(),
  testEnvironmentStorage: vi.fn(),
}));

import { getMyProjectAccessQuery } from "@/web/api/project-catalog";
import { meQuery } from "@/web/api/session";
import { requireOrgRole } from "@/web/project-guard";
import { StorageList } from "../web/routes/$locale/_app/-components/env/storage/storage-list";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function signedIn(orgRole: string, roles: Record<string, string>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(meQuery().queryKey, {
    id: "u1",
    orgRole,
  } as never);
  queryClient.setQueryData(getMyProjectAccessQuery().queryKey, {
    all: false,
    roles,
  } as never);
  return queryClient;
}

describe("requireOrgRole on a restricted target", () => {
  it("lets an engineer member through on a normal target only", async () => {
    const queryClient = signedIn("engineer", { p1: "engineer" });
    await expect(
      requireOrgRole(queryClient, { server: ["terminal"] })
    ).resolves.toBeDefined();
    await expect(
      requireOrgRole(queryClient, { server: ["terminal"] }, true)
    ).rejects.toMatchObject({ isNotFound: true });
    await expect(
      requireOrgRole(queryClient, { storage: ["files"] }, true)
    ).rejects.toMatchObject({ isNotFound: true });
  });

  it("lets infra through on a restricted target", async () => {
    const queryClient = signedIn("infra", {});
    await expect(
      requireOrgRole(queryClient, { server: ["files"] }, true)
    ).resolves.toBeDefined();
  });
});

const NORMAL = "0197f3a0-1b2c-7def-8000-0000000000b1";
const BACKUP = "0197f3a0-1b2c-7def-8000-0000000000b2";

function connection(id: string, isBackupDestination: boolean) {
  return {
    id,
    name: isBackupDestination ? "b-backups" : "a-assets",
    environmentId: null,
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: isBackupDestination ? "acme-backups" : "assets",
    keyPrefix: null,
    accessKeyId: "AKIA",
    forcePathStyle: true,
    hasSecret: true,
    isBackupDestination,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

let root: ReturnType<typeof createRoot> | undefined;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

describe("environment storage list", () => {
  it("offers no Browse, edit or delete on the backup bucket", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={new QueryClient()}>
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <StorageList
              environmentId="e1"
              basePath="/HMEM/dev/storage"
              connections={[
                connection(NORMAL, false),
                connection(BACKUP, true),
              ]}
              canManage
              canBrowse
            />
          </IntlProvider>
        </QueryClientProvider>
      );
    });
    expect(
      document.querySelector(`a[href='/HMEM/dev/storage/${NORMAL}/files']`)
    ).not.toBeNull();
    expect(
      document.querySelector(`a[href='/HMEM/dev/storage/${BACKUP}/files']`)
    ).toBeNull();
    expect(container.textContent).toContain(messages.storage.instanceBackups);
  });
});
