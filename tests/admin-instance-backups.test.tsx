// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  run: vi.fn(),
  acknowledge: vi.fn(),
  verify: vi.fn(),
  restore: vi.fn(),
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
vi.mock("@/web/routes/$locale/_app/-components/home/home-issue-dialog", () => ({
  useIssueDialog: () => ({
    open: vi.fn(),
    canCreateIn: () => false,
    canCreate: false,
  }),
}));
vi.mock("@/web/api/instance", () => ({
  getInstanceBackupsQuery: () => ({
    queryKey: ["instance", "getInstanceBackups"],
    queryFn: api.get,
  }),
  saveInstanceBackupSettings: api.save,
  runInstanceBackupNow: api.run,
  acknowledgeInstanceBackup: api.acknowledge,
  verifySecretsKey: api.verify,
  restoreInstanceBackup: api.restore,
}));

import { AttentionList } from "../web/routes/$locale/_app/-components/home/attention-list";
import { Route } from "../web/routes/$locale/_app/admin.instance";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DEST_ID = "0197f3a0-1b2c-7def-8000-0123456789d1";

function data(extra: { destinationId?: string | null } = {}) {
  return {
    instance: "opsdeck",
    settings: {
      destinationId: null as string | null,
      time: "02:30",
      keepDaily: 14,
      keepWeekly: 8,
      timeZone: "Asia/Jakarta",
      secretsKeyFingerprint: "0123456789abcdef",
      ...extra,
    },
    destinations: [{ id: DEST_ID, name: "R2 backups", bucket: "opsdeck" }],
    backups: [
      {
        id: "b1",
        startedAt: "2026-11-09T19:30:00.000Z",
        finishedAt: "2026-11-09T19:31:00.000Z",
        status: "succeeded",
        trigger: "schedule",
        version: "1.2.0",
        location: "s3",
        objectKey: "opsdeck-backups/opsdeck/x/",
        sizeBytes: 2048,
        errorCode: null,
        acknowledgedAt: null,
      },
      {
        id: "b2",
        startedAt: "2026-11-08T19:30:00.000Z",
        finishedAt: "2026-11-08T19:30:05.000Z",
        status: "failed",
        trigger: "manual",
        version: "1.1.9",
        location: "local",
        objectKey: null,
        sizeBytes: null,
        errorCode: "backupUploadFailed",
        acknowledgedAt: null,
      },
    ],
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(node: React.ReactNode, cached?: unknown) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (cached) {
    api.get.mockResolvedValue(cached);
    queryClient.setQueryData(["instance", "getInstanceBackups"], cached);
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          {node}
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

async function renderPage(cached: ReturnType<typeof data>) {
  const Page = Route.options.component as React.ComponentType;
  await render(<Page />, cached);
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const input = (name: string) =>
  container.querySelector<HTMLInputElement>(`input[name='${name}']`);

describe("Admin → Instance → Backups", () => {
  it("renders the settings, the history and both warnings", async () => {
    await renderPage(data());
    const text = container.textContent ?? "";
    const t = messages.instanceBackups;

    // Destination select, with "local only" chosen.
    const trigger = container.querySelector("[role='combobox']");
    expect(trigger?.textContent).toContain(t.destinationLocal);
    expect(input("time")?.value).toBe("02:30");
    expect(input("keepDaily")?.value).toBe("14");
    expect(input("keepWeekly")?.value).toBe("8");

    // History: version from the row, the failure's message by code.
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("1.2.0");
    expect(rows[1]?.textContent).toContain("1.1.9");
    expect(rows[1]?.textContent).toContain(t.errorCodes.backupUploadFailed);

    expect(text).toContain(t.notOffsiteTitle);
    expect(text).toContain(t.secretsKeyTitle);
    expect(text).toContain("0123456789abcdef");
  });

  it("hides the not-offsite warning once a destination is chosen", async () => {
    await renderPage(data({ destinationId: DEST_ID }));
    const t = messages.instanceBackups;
    expect(container.textContent).not.toContain(t.notOffsiteTitle);
    expect(container.textContent).toContain(t.secretsKeyTitle);
    const trigger = container.querySelector("[role='combobox']");
    expect(trigger?.textContent).toContain("R2 backups");
  });

  it("offers acknowledge only on an unacknowledged failure", async () => {
    await renderPage(data());
    const rows = container.querySelectorAll("tbody tr");
    const ack = messages.instanceBackups.acknowledge;
    expect(rows[0]?.textContent).not.toContain(ack);
    expect(rows[1]?.textContent).toContain(ack);
  });
});

describe("Restore from the history", () => {
  it("offers Restore only on a succeeded backup, behind the typed instance name", async () => {
    api.restore.mockResolvedValue({ requested: true });
    await renderPage(data());
    const label = messages.instanceBackups.restore;
    const rows = container.querySelectorAll("tbody tr");
    expect(rows[0]?.textContent).toContain(label);
    expect(rows[1]?.textContent).not.toContain(label);

    // The last match: the dialog's button comes after the row's trigger.
    const byText = (text: string) =>
      [...document.querySelectorAll("button")].findLast(
        (b) => b.textContent?.trim() === text
      );
    await act(async () => byText(label)?.click());
    const confirm = messages.instanceUpdates.restoreDialog.confirm;
    expect(document.body.textContent).toContain("opsdeck");
    expect(byText(confirm)?.disabled).toBe(true);
    const field = document.querySelector<HTMLInputElement>("#restore-confirm");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(field, "opsdeck");
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const fetches = api.get.mock.calls.length;
    await act(async () => byText(confirm)?.click());
    expect(api.restore).toHaveBeenCalledWith("b1", "opsdeck");
    // The instance queries are refetched, so the request shows at once.
    await vi.waitFor(() =>
      expect(api.get.mock.calls.length).toBeGreaterThan(fetches)
    );
  });
});

describe("SECRETS_KEY check", () => {
  it("shows the result and forgets the pasted key", async () => {
    api.verify.mockResolvedValue({ match: false });
    await renderPage(data());
    const field = container.querySelector<HTMLInputElement>(
      "#verify-secrets-key"
    );
    expect(field).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(field, "pasted-secret-key");
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      field?.form?.requestSubmit();
    });
    expect(api.verify).toHaveBeenCalledWith("pasted-secret-key");
    expect(container.textContent).toContain(
      messages.instanceBackups.keyMismatch
    );
    expect(field?.value).toBe("");
  });
});

describe("Home attention item", () => {
  it("shows a failed instance backup", async () => {
    await render(
      <AttentionList
        groups={[]}
        instanceBackup={{
          kind: "failed",
          backupId: "b2",
          errorCode: "backupUploadFailed",
          at: "2026-11-08T19:30:00.000Z",
        }}
      />
    );
    const item = container.querySelector("li");
    expect(item?.textContent).toContain(
      messages.homePage.attention.instanceBackupFailed
    );
    expect(item?.querySelector("a")?.getAttribute("href")).toBe(
      "/admin/instance"
    );
  });
});
