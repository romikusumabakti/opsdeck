// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locales } from "@/i18n/locales";
import messages from "../messages/en.json";

// Deleting an environment from Settings → Danger zone (a teardown, or
// "Remove from Panel only" for admins), and the banner the environment pages
// show while the teardown runs or after it stopped.

const ENV = "0197f3a0-1b2c-7def-8000-0123456789e1";
const RUN = "0197f3a0-1b2c-7def-8000-0123456789a1";
const ENGINEER = "engineer" as const;

const api = vi.hoisted(() => ({
  orgRole: "member" as string,
  startTeardown: vi.fn(),
  deleteEnvironment: vi.fn(),
  getTeardown: vi.fn(),
  retryTeardown: vi.fn(),
  cancelTeardown: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: api.push, back: vi.fn() }),
}));
vi.mock("@/web/api/session", () => ({
  useMe: () => ({ orgRole: api.orgRole }),
}));
vi.mock("@/web/api/environments", () => ({
  startTeardown: api.startTeardown,
  deleteEnvironment: api.deleteEnvironment,
  retryTeardown: api.retryTeardown,
  cancelTeardown: api.cancelTeardown,
  getTeardownQuery: (id: string) => ({
    queryKey: ["environments", "getTeardown", id],
    queryFn: () => api.getTeardown(id),
  }),
}));
vi.mock("@/components/live-run-dialog", () => ({
  LiveRunDialog: ({ runId }: { runId: string | null }) =>
    runId ? <p>live-run {runId}</p> : null,
}));

import { DialogProvider } from "@/components/dialog-provider";
import { ProjectRoleProvider } from "@/components/project-role";
import { ApiError } from "@/web/api/client";
import { DeleteEnvironmentCard } from "../web/routes/$locale/_app/-components/env/delete-environment-card";
import { TeardownBanner } from "../web/routes/$locale/_app/-components/env/teardown-banner";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = messages.environmentSettings;
const tt = messages.teardown;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <DialogProvider>
            <ProjectRoleProvider role={ENGINEER}>{node}</ProjectRoleProvider>
          </DialogProvider>
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

beforeEach(() => {
  api.orgRole = "member";
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

const body = () => document.body.textContent ?? "";
const button = (text: string) =>
  [...document.querySelectorAll("button")].findLast(
    (b) => b.textContent?.trim() === text
  );

async function type(selector: string, value: string) {
  const field = document.querySelector<HTMLInputElement>(selector);
  expect(field, selector).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(field, value);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openDialog(kind: "dev" | "prod" = "dev") {
  await render(
    <DeleteEnvironmentCard
      environment={{ id: ENV, name: "Dev 1", kind }}
      projectKey="HRIS"
    />
  );
  await act(async () => button(t.deleteButton)?.click());
}

describe("Delete environment dialog", () => {
  it("says what will be removed and that a backup is kept for 30 days", async () => {
    await openDialog();
    for (const text of [
      t.deleteRemovesContainers,
      t.deleteRemovesDatabase,
      t.deleteRemovesFolder,
      t.deleteRemovesAddress,
      t.deleteBackupKept,
    ]) {
      expect(body()).toContain(text);
    }
    expect(t.deleteBackupKept).toContain("30");
  });

  it("keeps Delete disabled until the typed name matches", async () => {
    api.startTeardown.mockResolvedValue({ runId: RUN });
    await openDialog();
    const confirm = () => button(t.deleteConfirm);
    expect(confirm()?.disabled).toBe(true);
    await type("#delete-environment-confirm", "Dev");
    expect(confirm()?.disabled).toBe(true);
    await type("#delete-environment-confirm", "Dev 1");
    expect(confirm()?.disabled).toBe(false);
    await act(async () => confirm()?.click());
    expect(api.startTeardown).toHaveBeenCalledWith(ENV, {
      confirmName: "Dev 1",
    });
  });

  it("shows a refusal by its code's localized message", async () => {
    api.startTeardown.mockRejectedValue(
      new ApiError(409, "Another environment uses this", "deployDirShared")
    );
    await openDialog();
    await type("#delete-environment-confirm", "Dev 1");
    await act(async () => button(t.deleteConfirm)?.click());
    expect(body()).toContain(tt.errors.deployDirShared);
  });

  it("offers Remove from Panel only to admins alone, under Advanced options", async () => {
    await openDialog();
    expect(body()).not.toContain(messages.setup.advancedOptions);
    expect(body()).not.toContain(t.removeFromPanel);
    act(() => root.unmount());
    container.remove();

    api.orgRole = "admin";
    api.deleteEnvironment.mockResolvedValue({ success: true });
    await openDialog();
    expect(button(t.removeFromPanel)).toBeUndefined();
    await act(async () => button(messages.setup.advancedOptions)?.click());
    expect(body()).toContain(t.removeFromPanelDescription);
    expect(button(t.removeFromPanel)?.disabled).toBe(true);
    await type("#delete-environment-confirm", "Dev 1");
    await act(async () => button(t.removeFromPanel)?.click());
    expect(api.deleteEnvironment).toHaveBeenCalledWith(ENV);
    expect(api.startTeardown).not.toHaveBeenCalled();
    expect(api.push).toHaveBeenCalledWith("/HRIS");
  });

  it("production: engineers get an explanation and no Delete button", async () => {
    await openDialog("prod");
    expect(body()).toContain(t.deleteProductionEngineer);
    expect(button(t.deleteConfirm)).toBeUndefined();
    expect(document.querySelector("#delete-environment-confirm")).toBeNull();
  });

  it("production: admins also tick the production confirmation", async () => {
    api.orgRole = "admin";
    api.startTeardown.mockResolvedValue({ runId: RUN });
    await openDialog("prod");
    expect(body()).not.toContain(t.deleteProductionEngineer);
    await type("#delete-environment-confirm", "Dev 1");
    expect(button(t.deleteConfirm)?.disabled).toBe(true);
    const box = document.querySelector<HTMLElement>(
      "#delete-environment-production"
    );
    expect(box).not.toBeNull();
    await act(async () => box?.click());
    expect(button(t.deleteConfirm)?.disabled).toBe(false);
    await act(async () => button(t.deleteConfirm)?.click());
    expect(api.startTeardown).toHaveBeenCalledWith(ENV, {
      confirmName: "Dev 1",
      confirmProduction: true,
    });
  });
});

const step = (
  kind: string,
  status: string,
  lastError: string | null = null
) => ({
  kind,
  status,
  lastError,
});

describe("Teardown banner", () => {
  it("shows nothing before any teardown", async () => {
    api.getTeardown.mockResolvedValue(null);
    await render(<TeardownBanner environmentId={ENV} projectKey="HRIS" />);
    expect(container.textContent).toBe("");
  });

  it("shows the running step and the run log", async () => {
    api.getTeardown.mockResolvedValue({
      runId: RUN,
      running: true,
      cancellable: false,
      steps: [
        step("check_stack", "done"),
        step("archive_database", "running"),
        step("delete_environment", "pending"),
      ],
    });
    await render(<TeardownBanner environmentId={ENV} projectKey="HRIS" />);
    await vi.waitFor(() =>
      expect(container.textContent).toContain(tt.steps.archive_database)
    );
    expect(container.textContent).toContain(tt.banner.runningTitle);
    expect(button(tt.banner.retry)).toBeUndefined();
    await act(async () => button(tt.banner.viewLog)?.click());
    expect(body()).toContain(`live-run ${RUN}`);
  });

  it("on a failed step shows the step, the code's message and Retry", async () => {
    api.getTeardown.mockResolvedValue({
      runId: RUN,
      running: false,
      cancellable: false,
      steps: [
        step("check_stack", "done"),
        step("stack_down", "done"),
        step("remove_deploy_dir", "failed", "serverCommandFailed"),
        step("delete_environment", "pending"),
      ],
    });
    api.retryTeardown.mockResolvedValue({ runId: RUN });
    await render(<TeardownBanner environmentId={ENV} projectKey="HRIS" />);
    await vi.waitFor(() =>
      expect(container.textContent).toContain(tt.banner.failedTitle)
    );
    expect(container.textContent).toContain(tt.steps.remove_deploy_dir);
    expect(container.textContent).toContain(tt.errors.serverCommandFailed);
    // A destructive step is done: no way back.
    expect(button(tt.banner.cancel)).toBeUndefined();
    await act(async () => button(tt.banner.retry)?.click());
    expect(api.retryTeardown).toHaveBeenCalledWith(ENV);
  });

  it("offers Cancel deletion only while the backend allows it, and says a stopped stack stays stopped", async () => {
    api.getTeardown.mockResolvedValue({
      runId: RUN,
      running: false,
      cancellable: true,
      steps: [
        step("check_stack", "done"),
        step("archive_database", "failed", "archiveFailed"),
      ],
    });
    api.cancelTeardown.mockResolvedValue({ cancelled: true });
    await render(<TeardownBanner environmentId={ENV} projectKey="HRIS" />);
    await vi.waitFor(() =>
      expect(button(tt.banner.cancel)).not.toBeUndefined()
    );
    expect(container.textContent).toContain(tt.errors.archiveFailed);
    await act(async () => button(tt.banner.cancel)?.click());
    expect(body()).toContain(tt.banner.cancelDescription);
    await act(async () => button(tt.banner.cancelConfirm)?.click());
    expect(api.cancelTeardown).toHaveBeenCalledWith(ENV);
  });

  it("goes to the project page once the environment is gone", async () => {
    api.getTeardown.mockRejectedValue(new ApiError(404, "Not found"));
    await render(<TeardownBanner environmentId={ENV} projectKey="HRIS" />);
    await vi.waitFor(() => expect(api.push).toHaveBeenCalledWith("/HRIS"));
  });
});

describe("Teardown messages", () => {
  const STEP_KINDS = [
    "check_stack",
    "archive_database",
    "stop_stack",
    "archive_deploy_dir",
    "archive_volumes",
    "stack_down",
    "drop_database",
    "remove_tunnel_route",
    "remove_access_app",
    "remove_dns_record",
    "remove_deploy_dir",
    "delete_environment",
  ];
  const read = (locale: string) =>
    JSON.parse(readFileSync(`messages/${locale}.json`, "utf8"));

  for (const locale of locales) {
    it(`${locale} names every step and renders the new activity events`, () => {
      const own = read(locale);
      for (const kind of STEP_KINDS) {
        expect(own.teardown.steps[kind], kind).toBeTruthy();
      }
      expect(own.activity.environmentDeleted).toContain("{environment}");
      expect(own.activity.environmentDomainAdopted).toContain("{hostname}");
    });
  }

  it("the activity page renders both actions", () => {
    const page = readFileSync(
      "web/routes/$locale/_app/admin.activity.tsx",
      "utf8"
    );
    expect(page).toContain('case "environment.deleted"');
    expect(page).toContain('case "environment.domain.adopted"');
  });
});
