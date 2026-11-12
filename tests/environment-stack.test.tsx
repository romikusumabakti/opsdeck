// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogProvider } from "@/components/dialog-provider";
import { ProjectRoleProvider } from "@/components/project-role";
import messages from "../messages/en.json";

const { getAllServiceStatuses, controlService, toastError } = vi.hoisted(
  () => ({
    getAllServiceStatuses: vi.fn(),
    controlService: vi.fn(),
    toastError: vi.fn(),
  })
);

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: toastError },
}));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children?: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/live-run-dialog", () => ({
  LiveRunDialog: ({ runId }: { runId: string | null }) =>
    runId ? <div data-testid="live-run">{runId}</div> : null,
}));
vi.mock("@/web/api/services", () => ({
  getAllServiceStatuses,
  controlService,
}));

import { EnvironmentStack } from "../web/routes/$locale/_app/-components/env/environment-stack";

const environment = {
  id: "e1",
  services: [
    {
      role: "db",
      serviceType: "docker",
      serviceName: "pg",
      server: { name: "s1" },
      dbType: "postgres",
      dbName: "app",
    },
    {
      role: "backend",
      serviceType: "docker",
      serviceName: "api",
      server: { name: "s1" },
    },
  ],
} as never;

const defaultStatuses = [
  { role: "db", state: "stopped" },
  { role: "backend", state: "running" },
];

let root: Root;
let container: HTMLDivElement;

async function mount(role: "viewer" | "qa" | "engineer" = "engineer") {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <DialogProvider>
          <ProjectRoleProvider role={role}>
            <EnvironmentStack environment={environment} envPath="/CRMB/dev" />
          </ProjectRoleProvider>
        </DialogProvider>
      </IntlProvider>
    )
  );
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

function rows(): [HTMLElement, HTMLElement] {
  const [db, backend] = container.querySelectorAll("li");
  if (!(db && backend)) throw new Error("expected two rows");
  return [db, backend];
}

// Buttons and links in `scope` whose text is exactly `label`.
function controls(scope: ParentNode, label: string): HTMLElement[] {
  return [...scope.querySelectorAll("button, a")].filter(
    (el) => el.textContent?.trim() === label
  ) as HTMLElement[];
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = controls(scope, label).find((el) => el.tagName === "BUTTON");
  if (!found) throw new Error(`no button ${label}`);
  return found as HTMLButtonElement;
}

beforeEach(() => {
  getAllServiceStatuses.mockReset();
  controlService.mockReset();
  toastError.mockReset();
  getAllServiceStatuses.mockResolvedValue(defaultStatuses);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("EnvironmentStack service actions", () => {
  it("an engineer sees Start, Stop, Restart and Logs", async () => {
    await mount("engineer");
    await settle();
    const [db, backend] = rows();
    expect(controls(db, "Start")).toHaveLength(1);
    expect(controls(db, "Stop")).toHaveLength(0);
    expect(controls(backend, "Stop")).toHaveLength(1);
    expect(controls(backend, "Start")).toHaveLength(0);
    for (const row of [db, backend]) {
      expect(controls(row, "Restart")).toHaveLength(1);
      expect(controls(row, "Logs")).toHaveLength(1);
    }
  });

  it("qa sees Restart and Logs but no Start or Stop", async () => {
    await mount("qa");
    await settle();
    expect(controls(container, "Start")).toHaveLength(0);
    expect(controls(container, "Stop")).toHaveLength(0);
    expect(controls(container, "Restart")).toHaveLength(2);
    expect(controls(container, "Logs")).toHaveLength(2);
  });

  it("a viewer sees only Logs", async () => {
    await mount("viewer");
    await settle();
    expect(controls(container, "Restart")).toHaveLength(0);
    const hrefs = controls(container, "Logs").map((el) =>
      el.getAttribute("href")
    );
    expect(hrefs).toEqual([
      "/CRMB/dev/services/db/logs",
      "/CRMB/dev/services/backend/logs",
    ]);
  });

  async function restartBackend() {
    controlService.mockResolvedValue({ runId: "r1" });
    await mount("engineer");
    await settle();
    await act(async () => button(rows()[1], "Restart").click());
    const confirm = [...document.body.querySelectorAll("button")]
      .filter((b) => b.textContent?.trim() === "Restart")
      .at(-1) as HTMLButtonElement;
    await act(async () => confirm.click());
    await settle();
  }

  it("Restart confirms, then opens the run dialog", async () => {
    await restartBackend();
    expect(controlService).toHaveBeenCalledWith("e1", "backend", "restart");
    expect(
      container.querySelector('[data-testid="live-run"]')?.textContent
    ).toBe("r1");
  });

  it("Refresh refetches without unmounting an open run dialog", async () => {
    await restartBackend();
    await act(async () => button(container, "Refresh").click());
    await settle();
    expect(getAllServiceStatuses).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="live-run"]')).not.toBeNull();
  });

  it("a failed probe leaves Restart disabled and Logs available", async () => {
    getAllServiceStatuses.mockRejectedValue(new Error("ssh down"));
    await mount("engineer");
    await settle();
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(controls(container, "Start")).toHaveLength(0);
    expect(controls(container, "Stop")).toHaveLength(0);
    const restarts = controls(container, "Restart") as HTMLButtonElement[];
    expect(restarts).toHaveLength(2);
    for (const r of restarts) expect(r.disabled).toBe(true);
    expect(controls(container, "Logs")).toHaveLength(2);
    expect(toastError).toHaveBeenCalled();
  });

  it("a not-found service disables Restart and Logs", async () => {
    getAllServiceStatuses.mockResolvedValue([
      { role: "db", state: "stopped" },
      { role: "backend", state: "not-found" },
    ]);
    await mount("engineer");
    await settle();
    const backend = rows()[1];
    expect((button(backend, "Restart") as HTMLButtonElement).disabled).toBe(
      true
    );
    expect((button(backend, "Logs") as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('a[href$="/backend/logs"]')).toBeNull();
  });
});
