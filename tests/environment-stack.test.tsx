// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogProvider } from "@/components/dialog-provider";
import { ProjectRoleProvider } from "@/components/project-role";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
            <EnvironmentStack environment={environment} envPath="/HMEM/dev" />
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

// The row's "More actions" menu trigger (Start / Stop), or null.
function moreActions(scope: ParentNode): HTMLButtonElement {
  return scope.querySelector(
    'button[aria-label="More actions"]'
  ) as HTMLButtonElement;
}

async function openMoreActions(row: HTMLElement) {
  await act(async () => moreActions(row).click());
  await settle();
}

// The labels of the open menu's items.
function menuItems(): string[] {
  return [...document.body.querySelectorAll('[role="menuitem"]')].map(
    (el) => el.textContent?.trim() ?? ""
  );
}

// Through cn(), as Button merges them.
const SM = cn(buttonVariants({ variant: "outline", size: "sm" }));
const ICON_SM = cn(buttonVariants({ variant: "ghost", size: "icon-sm" }));

// Every class of `expected` (a buttonVariants() string) is on `el`.
function hasClasses(el: Element | undefined, expected: string): boolean {
  if (!el) return false;
  return expected.split(" ").every((c) => el.classList.contains(c));
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
  it("an engineer sees Restart and Logs, and Start or Stop under More actions", async () => {
    await mount("engineer");
    await settle();
    const [db, backend] = rows();
    for (const row of [db, backend]) {
      // Start and Stop are menu items, not buttons on the row.
      expect(controls(row, "Start")).toHaveLength(0);
      expect(controls(row, "Stop")).toHaveLength(0);
      expect(controls(row, "Restart")).toHaveLength(1);
      expect(controls(row, "Logs")).toHaveLength(1);
      expect(moreActions(row)).not.toBeNull();
    }
    // The stopped db offers Start (the running backend's Stop: below).
    await openMoreActions(db);
    expect(menuItems()).toEqual(["Start"]);
  });

  it("Restart and Logs use the small button size, More actions the small icon size", async () => {
    await mount("engineer");
    await settle();
    const backend = rows()[1];
    expect(hasClasses(button(backend, "Restart"), SM)).toBe(true);
    expect(hasClasses(controls(backend, "Logs")[0], SM)).toBe(true);
    expect(hasClasses(moreActions(backend), ICON_SM)).toBe(true);
  });

  it("Stop from More actions confirms, then opens the run dialog", async () => {
    controlService.mockResolvedValue({ runId: "r2" });
    await mount("engineer");
    await settle();
    await openMoreActions(rows()[1]);
    expect(menuItems()).toEqual(["Stop"]);
    const stop = [
      ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((el) => el.textContent?.trim() === "Stop");
    if (!stop) throw new Error("no Stop item");
    await act(async () => stop.click());
    await settle();
    const dialog = document.body.querySelector('[role="alertdialog"]');
    if (!dialog) throw new Error("no confirm dialog");
    await act(async () => button(dialog, "Stop").click());
    await settle();
    expect(controlService).toHaveBeenCalledWith("e1", "backend", "stop");
    expect(
      container.querySelector('[data-testid="live-run"]')?.textContent
    ).toBe("r2");
  });

  it("qa sees Restart and Logs but no Start or Stop", async () => {
    await mount("qa");
    await settle();
    expect(controls(container, "Start")).toHaveLength(0);
    expect(controls(container, "Stop")).toHaveLength(0);
    expect(controls(container, "Restart")).toHaveLength(2);
    expect(controls(container, "Logs")).toHaveLength(2);
    expect(container.querySelector('[aria-label="More actions"]')).toBeNull();
  });

  it("a viewer sees only Logs", async () => {
    await mount("viewer");
    await settle();
    expect(controls(container, "Restart")).toHaveLength(0);
    const hrefs = controls(container, "Logs").map((el) =>
      el.getAttribute("href")
    );
    expect(hrefs).toEqual([
      "/HMEM/dev/services/db/logs",
      "/HMEM/dev/services/backend/logs",
    ]);
  });

  // Clicks the backend Restart, then confirms in the dialog.
  async function confirmBackendRestart() {
    await act(async () => button(rows()[1], "Restart").click());
    const dialog = document.body.querySelector('[role="alertdialog"]');
    if (!dialog) throw new Error("no confirm dialog");
    await act(async () => button(dialog, "Restart").click());
  }

  async function restartBackend() {
    controlService.mockResolvedValue({ runId: "r1" });
    await mount("engineer");
    await settle();
    await confirmBackendRestart();
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

  it("one pending action disables every row and spins only its own button", async () => {
    let resolve: (v: { runId: string }) => void = () => {};
    controlService.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    await mount("engineer");
    await settle();
    await confirmBackendRestart();
    await settle();

    const [db, backend] = rows();
    const actionButtons = (row: HTMLElement) =>
      [button(row, "Restart"), moreActions(row)] as HTMLButtonElement[];
    expect(actionButtons(db)).toHaveLength(2);
    expect(actionButtons(backend)).toHaveLength(2);
    for (const b of [...actionButtons(db), ...actionButtons(backend)])
      expect(b.disabled).toBe(true);
    expect(db.querySelector("svg.animate-spin")).toBeNull();
    expect(
      button(backend, "Restart").querySelector("svg.animate-spin")
    ).not.toBeNull();
    expect(backend.querySelectorAll("svg.animate-spin")).toHaveLength(1);
    // Logs is not an action on the service, so it stays available.
    for (const row of [db, backend])
      expect(row.querySelector('a[href$="/logs"]')).not.toBeNull();

    await act(async () => resolve({ runId: "r1" }));
    await settle();
    for (const b of [...actionButtons(db), ...actionButtons(backend)])
      expect(b.disabled).toBe(false);
    expect(container.querySelector("svg.animate-spin")).toBeNull();
  });
});
