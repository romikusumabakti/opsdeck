// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UPDATE_STATUS_CODES } from "@/lib/updates/request";
import ar from "../messages/ar.json";
import messages from "../messages/en.json";
import es from "../messages/es.json";
import id from "../messages/id.json";
import zh from "../messages/zh.json";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  apply: vi.fn(),
  restoreSafety: vi.fn(),
  restoreBackup: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-unsaved-changes", () => ({ useUnsavedChanges: () => {} }));
vi.mock("@/web/api/instance", () => ({
  getInstanceUpdatesQuery: () => ({
    queryKey: ["instance", "getInstanceUpdates"],
    queryFn: api.get,
  }),
  saveInstanceUpdateSettings: api.save,
  applyInstanceUpdate: api.apply,
  restoreSafetyBackup: api.restoreSafety,
  restoreInstanceBackup: api.restoreBackup,
}));

import { UpdatesTab } from "../web/routes/$locale/_app/-components/admin/instance/updates-tab";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = messages.instanceUpdates;

function data(extra: Record<string, unknown> = {}) {
  return {
    current: "1.2.0",
    instance: "opsdeck",
    channel: "stable",
    autoUpdate: false,
    window: "03:00",
    timeZone: "Asia/Jakarta",
    available: {
      version: "1.2.1",
      notesUrl:
        "https://github.com/romikusumabakti/opsdeck/releases/tag/v1.2.1",
      minFrom: "1.0.0",
    },
    checkError: null,
    checkedAt: "2026-11-09T10:00:00.000Z",
    updaterInstalled: true,
    pending: false,
    status: null,
    ...extra,
  };
}

function status(extra: Record<string, unknown> = {}) {
  return {
    runId: "20261109T200000Z-0a0b0c0d",
    action: "update",
    version: "1.2.1",
    from: "1.2.0",
    step: "migrate",
    state: "running",
    code: null,
    startedAt: "2026-11-09T20:00:00Z",
    finishedAt: null,
    logTail: ["step: migrate"],
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
  queryClient.setQueryData(["instance", "getInstanceUpdates"], cached);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <Suspense fallback="loading">
            <UpdatesTab />
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

const buttons = () => [...document.querySelectorAll("button")];
const button = (label: string) =>
  buttons().find((b) => b.textContent?.trim() === label);

describe("Admin → Instance → Updates", () => {
  it("shows the current and available version with the Update button", async () => {
    await render(data());
    const text = container.textContent ?? "";
    expect(text).toContain("Running 1.2.0 on the Stable channel.");
    expect(text).toContain("Version 1.2.1 is available.");
    expect(
      container.querySelector("a[href$='/v1.2.1']")?.textContent
    ).toContain(t.releaseNotes);
    const update = button(t.update);
    expect(update).toBeDefined();
    expect(update?.disabled).toBe(false);
  });

  it("asks for confirmation, then requests the update", async () => {
    api.apply.mockResolvedValue({ requested: true });
    await render(data());
    await act(async () => button(t.update)?.click());
    expect(document.body.textContent).toContain("Update to 1.2.1?");
    const confirm = buttons().filter((b) => b.textContent?.trim() === t.update);
    await act(async () => confirm.at(-1)?.click());
    expect(api.apply).toHaveBeenCalledWith("1.2.1");
  });

  it("after Update, refetches and shows the progress (no running data seeded)", async () => {
    api.apply.mockResolvedValue({ requested: true });
    await render(data());
    expect(container.textContent).not.toContain(t.pending);
    // What the server says once the request is written, then once it runs.
    api.get.mockResolvedValueOnce(data({ pending: true }));
    await act(async () => button(t.update)?.click());
    const confirm = buttons().filter((b) => b.textContent?.trim() === t.update);
    await act(async () => confirm.at(-1)?.click());
    await vi.waitFor(() => expect(container.textContent).toContain(t.pending));
    expect(button(t.update)?.disabled).toBe(true);

    api.get.mockResolvedValue(data({ status: status({ step: "pull" }) }));
    // Pending/running data polls every 2 s.
    await vi.waitFor(
      () =>
        expect(
          container
            .querySelector("li[data-step='pull']")
            ?.getAttribute("data-state")
        ).toBe("active"),
      { timeout: 4000 }
    );
    expect(button(t.update)?.disabled).toBe(true);
  });

  it("hints that auto-update skips a version whose last run failed", async () => {
    await render(data({ autoUpdate: true, autoUpdateSkipped: true }));
    expect(container.textContent).toContain(
      "Auto-update skips 1.2.1: its last run did not succeed."
    );
  });

  it("says up to date with nothing available", async () => {
    await render(data({ available: null }));
    expect(container.textContent).toContain(t.upToDate);
    expect(button(t.update)).toBeUndefined();
  });

  it("shows the live step progress of a running update and disables Update", async () => {
    await render(data({ status: status() }));
    const steps = [...container.querySelectorAll("li[data-step]")];
    expect(steps.map((s) => s.getAttribute("data-step"))).toEqual([
      "validate",
      "backup",
      "pull",
      "migrate",
      "up",
      "health",
      "done",
    ]);
    const stateOf = (step: string) =>
      container
        .querySelector(`li[data-step='${step}']`)
        ?.getAttribute("data-state");
    expect(stateOf("pull")).toBe("done");
    expect(stateOf("migrate")).toBe("active");
    expect(stateOf("up")).toBe("todo");
    expect(container.textContent).toContain(t.states.running);
    expect(button(t.update)?.disabled).toBe(true);
  });

  it("shows the rolled-back message by code", async () => {
    await render(
      data({
        status: status({
          step: "rollback",
          state: "rolled_back",
          code: "healthFailed",
          finishedAt: "2026-11-09T20:05:00Z",
        }),
      })
    );
    const text = container.textContent ?? "";
    expect(text).toContain(t.rolledBackTitle);
    expect(text).toContain(t.statusCodes.healthFailed);
    expect(
      container
        .querySelector("li[data-step='rollback']")
        ?.getAttribute("data-state")
    ).toBe("done");
  });

  it("says a restore stands on the backup's version when only its follow-up update rolled back", async () => {
    await render(
      data({
        status: status({
          action: "restore",
          version: "1.1.0",
          from: "1.1.0",
          step: "rollback",
          state: "rolled_back",
          code: "healthFailed",
          restored: true,
          finishedAt: "2026-11-09T20:05:00Z",
        }),
      })
    );
    const text = container.textContent ?? "";
    expect(text).toContain(t.restoredRolledBackTitle);
    expect(text).toContain(t.restoredRolledBack.replace("{version}", "1.1.0"));
    expect(text).not.toContain(t.rolledBackTitle);
  });

  it("keeps the plain rollback wording for a restore refused before any change", async () => {
    await render(
      data({
        status: status({
          action: "restore",
          version: "1.1.0",
          step: "rollback",
          state: "rolled_back",
          code: "restoreKeyMismatch",
          finishedAt: "2026-11-09T20:05:00Z",
        }),
      })
    );
    const text = container.textContent ?? "";
    expect(text).toContain(t.rolledBackTitle);
    expect(text).toContain(t.statusCodes.restoreKeyMismatch);
    expect(text).not.toContain(t.restoredRolledBackTitle);
  });

  it("does not claim the previous version runs after a failed, interrupted run", async () => {
    await render(
      data({
        status: status({ state: "failed", code: "interrupted" }),
      })
    );
    const text = container.textContent ?? "";
    expect(text).toContain(t.interruptedFailed);
    expect(text).not.toContain(t.statusCodes.interrupted);
    // Not busy: an admin may start another run.
    expect(button(t.update)?.disabled).toBe(false);
  });

  it("offers the safety backup after a failed restore, behind the typed name", async () => {
    api.restoreSafety.mockResolvedValue({ requested: true });
    await render(
      data({
        status: status({
          action: "restore",
          version: "1.1.0",
          step: "health",
          state: "failed",
          code: "restoreFailed",
          finishedAt: "2026-11-09T20:05:00Z",
          safetyBackup: {
            id: null,
            location: "local",
            objectKey: "opsdeck/x/",
          },
        }),
      })
    );
    expect(container.textContent).toContain(t.statusCodes.restoreFailed);
    await act(async () => button(t.restoreSafety)?.click());
    const confirm = button(t.restoreDialog.confirm);
    expect(confirm?.disabled).toBe(true);
    const field = document.querySelector<HTMLInputElement>("#restore-confirm");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set?.call(field, "opsdeck");
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button(t.restoreDialog.confirm)?.disabled).toBe(false);
    await act(async () => button(t.restoreDialog.confirm)?.click());
    expect(api.restoreSafety).toHaveBeenCalledWith("opsdeck");
  });

  it("shows the updater-missing state", async () => {
    await render(data({ updaterInstalled: false }));
    expect(container.textContent).toContain(t.updaterMissingTitle);
    expect(button(t.update)?.disabled).toBe(true);
  });

  it("warns when the check failed, keeping the last known release", async () => {
    await render(data({ checkError: "updateCheckFailed" }));
    expect(container.textContent).toContain(t.checkFailed);
    expect(container.textContent).toContain("Version 1.2.1 is available.");
  });
});

describe("messages", () => {
  it("every updater status code and new error code has a message in all 5 locales", () => {
    for (const [locale, m] of Object.entries({
      en: messages,
      id,
      es,
      zh,
      ar,
    })) {
      const u = m.instanceUpdates as unknown as {
        statusCodes: Record<string, string>;
        errors: Record<string, string>;
      };
      for (const code of UPDATE_STATUS_CODES) {
        expect(u.statusCodes[code], `${locale} ${code}`).toBeTruthy();
      }
      for (const code of [
        "updateNotAvailable",
        "confirmMismatch",
        "updaterMissing",
        "updateInProgress",
        "belowMinFrom",
        "restoreNotFound",
        "restoreKeyMismatch",
        "restoreVersionMismatch",
        "updateCheckFailed",
      ]) {
        expect(u.errors[code], `${locale} ${code}`).toBeTruthy();
      }
    }
  });
});
