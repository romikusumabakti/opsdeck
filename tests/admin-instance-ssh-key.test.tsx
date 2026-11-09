// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  moveAll: vi.fn(),
  rotate: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/dialog-provider", () => ({
  useDialog: () => ({ confirm: api.confirm }),
}));
vi.mock("@/web/api/instance", () => ({
  getInstanceSshKeyQuery: () => ({
    queryKey: ["instance", "getInstanceSshKey"],
    queryFn: api.get,
  }),
  moveAllServersToKey: api.moveAll,
  rotateInstanceSshKey: api.rotate,
}));

import { SshKeyTab } from "../web/routes/$locale/_app/-components/admin/instance/ssh-key-tab";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = messages.instanceSshKey;
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPanelKey";

function data(lastJob: Record<string, unknown> | null = null) {
  return {
    publicKey: PUBLIC_KEY,
    fingerprint: "SHA256:instanceFp",
    lastJob,
  };
}

function job(extra: Record<string, unknown> = {}) {
  return {
    kind: "moveAll",
    requestedAt: "2026-11-09T10:00:00.000Z",
    startedAt: "2026-11-09T10:00:01.000Z",
    finishedAt: "2026-11-09T10:01:00.000Z",
    errorCode: null,
    results: [
      { serverId: "s1", name: "web-1", ok: true, code: null },
      { serverId: "s2", name: "db-1", ok: false, code: "sudoNeedsPassword" },
    ],
    ...extra,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(cached: ReturnType<typeof data>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  api.get.mockResolvedValue(cached);
  queryClient.setQueryData(["instance", "getInstanceSshKey"], cached);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <Suspense fallback="loading">
            <SshKeyTab />
          </Suspense>
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label
  );

describe("Admin → Instance → SSH key", () => {
  it("shows the public key with copy and the fingerprint", async () => {
    await render(data());
    expect(text()).toContain(PUBLIC_KEY);
    expect(text()).toContain("SHA256:instanceFp");
    expect(
      container.querySelector(`button[aria-label='${messages.common.copy}']`)
    ).not.toBeNull();
    expect(text()).not.toContain("PRIVATE");
  });

  it("Move all asks first, then queues the job", async () => {
    api.confirm.mockResolvedValue(true);
    api.moveAll.mockResolvedValue({ queued: true });
    await render(data());
    await act(async () => button(t.moveAll)?.click());
    expect(api.confirm).toHaveBeenCalled();
    expect(api.moveAll).toHaveBeenCalled();
  });

  it("Rotate's confirm says failing servers keep the old key and are listed", async () => {
    api.confirm.mockResolvedValue(false);
    await render(data());
    await act(async () => button(t.rotate)?.click());
    const options = api.confirm.mock.calls[0]?.[0];
    expect(String(options.description)).toBe(t.rotateDescription);
    expect(t.rotateDescription).toMatch(/keep the old key/);
    expect(t.rotateDescription).toMatch(/listed/);
    expect(api.rotate).not.toHaveBeenCalled();
  });

  it("a running job shows progress and disables both actions", async () => {
    await render(
      data(
        job({
          finishedAt: null,
          results: [{ serverId: "s1", name: "web-1", ok: true, code: null }],
        })
      )
    );
    expect(text()).toContain("web-1");
    expect(text()).toContain(
      t.runningMoveAll.replace(
        "{count, plural, one {# server} other {# servers}}",
        "1 server"
      )
    );
    expect(button(t.moveAll)?.disabled).toBe(true);
    expect(button(t.rotate)?.disabled).toBe(true);
  });

  it("a finished job lists every server with its result and the reason it failed", async () => {
    await render(data(job()));
    const rows = [...container.querySelectorAll("tbody tr")].map(
      (tr) => tr.textContent ?? ""
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("web-1");
    expect(rows[0]).toContain(t.ok);
    expect(rows[1]).toContain("db-1");
    expect(rows[1]).toContain(t.failed);
    expect(rows[1]).toContain(messages.actionErrors.sudoNeedsPassword);
    expect(button(t.moveAll)?.disabled).toBe(false);
  });
});
