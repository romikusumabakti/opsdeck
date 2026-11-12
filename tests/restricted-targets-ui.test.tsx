// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

// The browser side of restricted targets: the page guard for a terminal or
// file page, and the storage list's Browse button, take the org role alone on
// an infra-only server or the instance backup bucket.

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
vi.mock("@/web/api/s3-connections", () => ({
  deleteS3Connection: vi.fn(),
}));

import { getMyProjectAccessQuery } from "@/web/api/project-catalog";
import { meQuery } from "@/web/api/session";
import { requireOrgRole } from "@/web/project-guard";
import { StorageClient } from "../web/routes/$locale/_app/-components/storage/storage-client";

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
    const queryClient = signedIn("member", { p1: "engineer" });
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
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: isBackupDestination ? "panel-backups" : "assets",
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

describe("storage list", () => {
  it("hides Browse on the backup bucket for an engineer member", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={new QueryClient()}>
          <IntlProvider locale="en" messages={messages} timeZone="UTC">
            <StorageClient
              connections={[
                connection(NORMAL, false),
                connection(BACKUP, true),
              ]}
              can={{
                manage: false,
                files: (isBackupDestination) => !isBackupDestination,
              }}
            />
          </IntlProvider>
        </QueryClientProvider>
      );
    });
    expect(
      document.querySelector(`a[href='/storage/${NORMAL}/files']`)
    ).not.toBeNull();
    expect(
      document.querySelector(`a[href='/storage/${BACKUP}/files']`)
    ).toBeNull();
  });
});
