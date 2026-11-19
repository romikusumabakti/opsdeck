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
  saveDestination: vi.fn(),
  clearDestination: vi.fn(),
  testDestination: vi.fn(),
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
  saveBackupDestination: api.saveDestination,
  clearBackupDestination: api.clearDestination,
  testBackupDestination: api.testDestination,
  listEnvironmentArchivesQuery: () => ({
    queryKey: ["instance", "listEnvironmentArchives"],
    queryFn: async () => [],
  }),
  environmentArchiveFileHref: () => "",
}));

import { DialogProvider } from "@/components/dialog-provider";
import { AttentionList } from "../web/routes/$locale/_app/-components/home/attention-list";
import { Route } from "../web/routes/$locale/_app/admin.instance";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const DESTINATION = {
  endpoint: "https://objects.example.test",
  region: "auto",
  bucket: "fictional-panel-backups",
  accessKeyId: "AKFICTIONALPANEL",
  forcePathStyle: true,
  keyPrefix: "panel/" as string | null,
  secretSet: true,
};

function data(extra: { destination?: typeof DESTINATION | null } = {}) {
  return {
    instance: "menara",
    destination: extra.destination ?? null,
    settings: {
      time: "02:30",
      keepDaily: 14,
      keepWeekly: 8,
      timeZone: "Asia/Jakarta",
      secretsKeyFingerprint: "0123456789abcdef",
    },
    backups: [
      {
        id: "b1",
        startedAt: "2026-11-09T19:30:00.000Z",
        finishedAt: "2026-11-09T19:31:00.000Z",
        status: "succeeded",
        trigger: "schedule",
        version: "1.2.0",
        location: "s3",
        objectKey: "menara-backups/menara/x/",
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
          <DialogProvider>{node}</DialogProvider>
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
const byId = (id: string) =>
  container.querySelector<HTMLInputElement>(`#${id}`);

async function type(field: HTMLInputElement | null, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(field, value);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Admin → Instance → Backups", () => {
  it("renders the settings, the history and both warnings", async () => {
    await renderPage(data());
    const text = container.textContent ?? "";
    const t = messages.instanceBackups;

    // An empty destination form: no picker of connections any more.
    expect(container.querySelector("[role='combobox']")).toBeNull();
    expect(text).toContain(t.destinationCard.title);
    expect(byId("backup-destination-endpoint")?.value).toBe("");
    expect(byId("backup-destination-region")?.value).toBe("auto");
    expect(text).not.toContain(t.destinationCard.remove);
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

  it("hides the not-offsite warning once a destination is set, and shows it without the secret", async () => {
    await renderPage(data({ destination: DESTINATION }));
    const t = messages.instanceBackups;
    expect(container.textContent).not.toContain(t.notOffsiteTitle);
    expect(container.textContent).toContain(t.secretsKeyTitle);
    expect(byId("backup-destination-endpoint")?.value).toBe(
      DESTINATION.endpoint
    );
    expect(byId("backup-destination-bucket")?.value).toBe(DESTINATION.bucket);
    expect(byId("backup-destination-keyPrefix")?.value).toBe("panel/");
    const secret = byId("backup-destination-secretKey");
    expect(secret?.value).toBe("");
    expect(secret?.placeholder).toBe(t.destinationCard.secretKeyPlaceholderSet);
  });

  it("saves the destination keeping the stored secret when it is left blank", async () => {
    api.saveDestination.mockResolvedValue(DESTINATION);
    await renderPage(data({ destination: DESTINATION }));
    await type(byId("backup-destination-bucket"), "fictional-other-bucket");
    await act(async () => {
      byId("backup-destination-bucket")?.form?.requestSubmit();
    });
    await vi.waitFor(() =>
      expect(api.saveDestination).toHaveBeenCalledWith({
        endpoint: DESTINATION.endpoint,
        region: "auto",
        bucket: "fictional-other-bucket",
        accessKeyId: DESTINATION.accessKeyId,
        keyPrefix: "panel/",
        forcePathStyle: true,
      })
    );
  });

  it("needs the secret for a new destination", async () => {
    await renderPage(data());
    await type(
      byId("backup-destination-endpoint"),
      "https://objects.example.test"
    );
    await type(byId("backup-destination-bucket"), "fictional-panel-backups");
    await type(byId("backup-destination-accessKeyId"), "AKFICTIONALPANEL");
    await act(async () => {
      byId("backup-destination-bucket")?.form?.requestSubmit();
    });
    expect(api.saveDestination).not.toHaveBeenCalled();
    await type(byId("backup-destination-secretKey"), "fictional-secret");
    await act(async () => {
      byId("backup-destination-bucket")?.form?.requestSubmit();
    });
    await vi.waitFor(() =>
      expect(api.saveDestination).toHaveBeenCalledWith(
        expect.objectContaining({
          secretKey: "fictional-secret",
          keyPrefix: null,
        })
      )
    );
  });

  it("removes the destination after a confirmation", async () => {
    api.clearDestination.mockResolvedValue({ success: true });
    await renderPage(data({ destination: DESTINATION }));
    const remove = messages.instanceBackups.destinationCard.remove;
    const byText = (label: string) =>
      [...document.querySelectorAll("button")].findLast(
        (b) => b.textContent?.trim() === label
      );
    await act(async () => byText(remove)?.click());
    expect(api.clearDestination).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      messages.instanceBackups.destinationCard.removeTitle
    );
    await act(async () => byText(remove)?.click());
    await vi.waitFor(() => expect(api.clearDestination).toHaveBeenCalled());
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
    expect(document.body.textContent).toContain("menara");
    expect(byText(confirm)?.disabled).toBe(true);
    const field = document.querySelector<HTMLInputElement>("#restore-confirm");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(field, "menara");
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const fetches = api.get.mock.calls.length;
    await act(async () => byText(confirm)?.click());
    expect(api.restore).toHaveBeenCalledWith("b1", "menara");
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
