// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

// Admin → Instance → Backups, "Deleted environments": the archives that
// teardowns kept, with their expiry and a download link per file.

const ARCHIVE = "0197f3a0-1b2c-7def-8000-0123456789d1";
const OPEN_ARCHIVE = "0197f3a0-1b2c-7def-8000-0123456789d2";

const api = vi.hoisted(() => ({ archives: vi.fn() }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-unsaved-changes", () => ({ useUnsavedChanges: () => {} }));
vi.mock("@/web/api/instance", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getInstanceBackupsQuery: () => ({
    queryKey: ["instance", "getInstanceBackups"],
    queryFn: async () => backups,
  }),
  listEnvironmentArchivesQuery: () => ({
    queryKey: ["instance", "listEnvironmentArchives"],
    queryFn: api.archives,
  }),
}));

import { BackupsTab } from "../web/routes/$locale/_app/-components/admin/instance/backups-tab";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const backups = {
  instance: "opsdeck",
  settings: {
    destinationId: "x",
    time: "02:30",
    keepDaily: 14,
    keepWeekly: 8,
    timeZone: "UTC",
    secretsKeyFingerprint: null,
  },
  destinations: [],
  backups: [],
};

const t = messages.instanceBackups.deletedEnvironments;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(["instance", "getInstanceBackups"], backups);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider
          locale="en"
          messages={messages}
          timeZone="UTC"
          now={new Date("2026-11-10T00:00:00Z")}
        >
          <BackupsTab />
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

describe("Deleted environments", () => {
  it("lists the archives with their expiry and download links", async () => {
    api.archives.mockResolvedValue([
      {
        id: ARCHIVE,
        projectName: "HRIS",
        environmentName: "HRIS Dev",
        createdAt: "2026-11-01T00:00:00.000Z",
        expiresAt: "2026-12-01T00:05:00.000Z",
        completedAt: "2026-11-01T00:05:00.000Z",
        files: [
          { name: "db-hris-0123456789.dump", size: 2048 },
          { name: "dir-hris-0123456789.tar.gz", size: 10 },
        ],
      },
      {
        id: OPEN_ARCHIVE,
        projectName: "DMS",
        environmentName: "DMS Dev",
        createdAt: "2026-11-09T00:00:00.000Z",
        expiresAt: "2026-12-09T00:00:00.000Z",
        completedAt: null,
        files: [],
      },
    ]);
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain("HRIS Dev"));
    const section = [...container.querySelectorAll("[data-slot='card']")].find(
      (card) => card.textContent?.includes(t.title)
    );
    expect(section).toBeDefined();
    const rows = section?.querySelectorAll("tbody tr") ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("HRIS");
    // The expiry, as a time element of its date.
    const expiry = rows[0]?.querySelector(
      "time[datetime='2026-12-01T00:05:00.000Z']"
    );
    expect(expiry).not.toBeNull();
    const links = [...(rows[0]?.querySelectorAll("a") ?? [])];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      `/api/instance/environment-archives/${ARCHIVE}/files/db-hris-0123456789.dump`,
      `/api/instance/environment-archives/${ARCHIVE}/files/dir-hris-0123456789.tar.gz`,
    ]);
    expect(links[0]?.textContent).toContain("db-hris-0123456789.dump");
    // A teardown that has not deleted its environment yet.
    expect(rows[1]?.textContent).toContain(t.incomplete);
  });

  it("says so when there are none", async () => {
    api.archives.mockResolvedValue([]);
    await render();
    await vi.waitFor(() => expect(container.textContent).toContain(t.empty));
  });
});
