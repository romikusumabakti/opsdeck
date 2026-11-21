// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogProvider } from "@/components/dialog-provider";
import { ProjectRoleProvider } from "@/components/project-role";
import messages from "../messages/en.json";

const state = vi.hoisted(() => ({
  rollbackTarget: vi.fn(),
  deployTag: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/web/api/service-catalog", () => ({
  startComponentBuild: vi.fn(),
  getActiveBuild: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/components/live-run-dialog", () => ({
  LiveRunDialog: ({ runId }: { runId: string | null }) =>
    runId && <p>run:{runId}</p>,
}));
vi.mock("@/web/api/deploys", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  rollbackTarget: state.rollbackTarget,
  deployTag: state.deployTag,
}));
vi.mock(
  "../web/routes/$locale/_app/-components/env/deploys/deploy-lock",
  () => ({
    DeployLockPanel: () => null,
    useDeployLock: () => ({ data: { lock: null } }),
  })
);
vi.mock(
  "../web/routes/$locale/_app/-components/env/provisioning-panel",
  () => ({ ProvisioningPanel: () => null })
);

import { DeploysClient } from "../web/routes/$locale/_app/-components/env/deploys/deploys-client";

const d = messages.deploys;
const environment = { id: "e1", ownerId: null, services: [] } as never;
const at = (time: string) => new Date(`2026-11-12T${time}Z`);
const NOW = at("10:05:00");

function build(tag: string, receivedAt: Date, extra = {}) {
  return {
    id: `b-${tag}`,
    tag,
    commitSha: `${tag}abcdef0123`,
    commitMessage: `Change ${tag}\n\nBody`,
    commitAuthorEmail: null,
    pipelineUrl: `https://ci.example.com/${tag}`,
    receivedAt,
    ...extra,
  };
}

function deployment(
  tag: string,
  status: string,
  o: {
    id?: string;
    createdAt?: Date;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    runId?: string | null;
    userName?: string;
    trigger?: string;
    build?: { branch: string; commitSha: string } | null;
  } = {}
) {
  const createdAt = o.createdAt ?? at("09:00:00");
  return {
    id: o.id ?? `d-${tag}-${status}`,
    tag,
    status,
    trigger: o.trigger ?? "manual",
    runId: o.runId === undefined ? `run-${tag}` : o.runId,
    userName: o.userName ?? "Ada Example",
    triggeredBy: null,
    autoUser: null,
    build: o.build ?? null,
    createdAt,
    startedAt: o.startedAt === undefined ? createdAt : o.startedAt,
    finishedAt: o.finishedAt === undefined ? createdAt : o.finishedAt,
  };
}

function target(extra: Record<string, unknown> = {}) {
  return {
    id: "a",
    componentKey: "app-a",
    repoFullName: "acme/app",
    sourceBranch: "main",
    serverId: "s1",
    deployDir: "/srv/a",
    services: ["web"],
    kind: "compose",
    autoDeploy: false,
    deployNextBuild: false,
    currentTag: null,
    currentStatus: null,
    previousTag: null,
    recentBuilds: [],
    recentDeployments: [],
    ...extra,
  };
}

const liveTarget = (extra: Record<string, unknown> = {}) =>
  target({
    currentTag: "v2",
    currentStatus: "success",
    previousTag: "v1",
    recentBuilds: [build("v2", at("09:50:00")), build("v1", at("09:00:00"))],
    recentDeployments: [
      deployment("v2", "success", {
        createdAt: at("10:00:00"),
        finishedAt: at("10:01:30"),
      }),
      deployment("v1", "success", { createdAt: at("09:10:00") }),
    ],
    ...extra,
  });

let root: Root;
let container: HTMLDivElement;

async function render(
  targets: Record<string, unknown>[],
  role: "viewer" | "engineer" = "engineer"
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC" now={NOW}>
          <DialogProvider>
            <ProjectRoleProvider role={role}>
              <DeploysClient
                environment={environment}
                targets={targets as never}
                settingsHref="/s"
                addTargetHref="/a"
              />
            </ProjectRoleProvider>
          </DialogProvider>
        </IntlProvider>
      </QueryClientProvider>
    )
  );
}

async function mount(
  targets: Record<string, unknown>[],
  role: "viewer" | "engineer" = "engineer"
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render(targets, role);
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

const rows = () =>
  [
    ...container.querySelectorAll<HTMLElement>('[data-slot="timeline-row"]'),
  ] as HTMLElement[];
const rowTags = () =>
  rows().map((r) => r.querySelector('[data-slot="row-tag"]')?.textContent);
const row = (tag: string) => {
  const found = rows().find(
    (r) => r.querySelector('[data-slot="row-tag"]')?.textContent === tag
  );
  if (!found) throw new Error(`no row ${tag}`);
  return found;
};
const statusOf = (tag: string) =>
  row(tag).querySelector('[data-slot="row-status"]');
const menuTrigger = (tag: string) =>
  container.querySelector<HTMLButtonElement>(
    `button[aria-label="${d.rowActionsLabel.replace("{tag}", tag)}"]`
  );

async function openRowMenu(tag: string) {
  const trigger = menuTrigger(tag);
  if (!trigger) throw new Error(`no menu for ${tag}`);
  await act(async () => trigger.click());
  await settle();
}

async function closeRowMenu(tag: string) {
  await act(async () => menuTrigger(tag)?.click());
  await settle();
}

const menuElements = () => [
  ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
];
const menuItems = () => menuElements().map((el) => el.textContent?.trim());
const menuItem = (label: string) =>
  menuElements().find((el) => el.textContent?.startsWith(label));
const alertDialog = () => document.querySelector('[role="alertdialog"]');
const buttonIn = (scope: ParentNode | null | undefined, text: string) =>
  [...(scope?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent === text
  );

beforeEach(() => {
  state.rollbackTarget.mockReset().mockResolvedValue({ runId: "run-rb" });
  state.deployTag.mockReset().mockResolvedValue({ runId: "run-dp" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("Deploy timeline", () => {
  it("one row per tag, newest build first, a deploy-only tag included", async () => {
    await mount([
      target({
        recentBuilds: [
          build("v3", at("10:00:00")),
          build("v2", at("09:00:00")),
        ],
        recentDeployments: [
          deployment("v9-old", "success", { createdAt: at("08:00:00") }),
          deployment("v2", "success", { createdAt: at("09:10:00") }),
        ],
      }),
    ]);
    expect(rowTags()).toEqual(["v3", "v2", "v9-old"]);
  });

  it("live row carries the Live badge and highlight; previous row reads Previous", async () => {
    await mount([liveTarget()]);
    const live = row("v2");
    expect(live.dataset.status).toBe("live");
    expect(live.classList.contains("bg-success/5")).toBe(true);
    expect(
      statusOf("v2")?.querySelector('[data-slot="badge"]')?.textContent
    ).toBe(d.row.live);
    expect(row("v1").dataset.status).toBe("previous");
    expect(statusOf("v1")?.textContent).toContain(d.row.previous);
  });

  it("each status pairs an icon with text", async () => {
    await mount([
      target({
        currentTag: "v2",
        currentStatus: "success",
        previousTag: "v1",
        recentBuilds: [
          build("v8", at("09:58:00")),
          build("v7", at("09:57:00")),
          build("v6", at("09:56:00")),
          build("v5", at("09:55:00")),
          build("v4", at("09:54:00")),
          build("v3", at("09:53:00")),
          build("v2", at("09:52:00")),
          build("v1", at("09:51:00")),
          build("v0", at("09:50:00")),
        ],
        recentDeployments: [
          deployment("v8", "queued", { startedAt: null, finishedAt: null }),
          deployment("v7", "running", { finishedAt: null }),
          deployment("v6", "held", { runId: null, finishedAt: null }),
          deployment("v5", "superseded"),
          deployment("v4", "failed"),
          deployment("v2", "success"),
          deployment("v1", "success"),
          deployment("v0", "success"),
        ],
      }),
      target({
        id: "b",
        componentKey: "app-b",
        currentTag: "v2",
        currentStatus: "failed",
        previousTag: "v1",
        recentBuilds: [
          build("v2", at("09:50:00")),
          build("v1", at("09:00:00")),
        ],
        recentDeployments: [
          deployment("v2", "failed"),
          deployment("v1", "success"),
        ],
      }),
    ]);
    const seen = new Set<string>();
    for (const r of rows()) {
      const status = r.dataset.status ?? "";
      seen.add(status);
      const cell = r.querySelector('[data-slot="row-status"]');
      // "—" stands in for the icon of a never-deployed row (next test).
      if (status !== "never") {
        expect(cell?.querySelector("svg"), status).not.toBeNull();
      }
      expect(cell?.textContent?.trim(), status).toBeTruthy();
    }
    expect([...seen].sort()).toEqual(
      [
        "live",
        "previous",
        "lastGood",
        "queued",
        "deploying",
        "held",
        "failed",
        "skipped",
        "deployedEarlier",
        "never",
      ].sort()
    );
  });

  it("a never-deployed row reads — with the status for screen readers", async () => {
    await mount([target({ recentBuilds: [build("v1", at("09:00:00"))] })]);
    const cell = statusOf("v1");
    expect(cell?.textContent).toContain("—");
    expect(cell?.querySelector(".sr-only")?.textContent).toBe(d.row.never);
  });

  it("row menu items per state", async () => {
    await mount([
      liveTarget({
        recentBuilds: [
          build("v2", at("09:50:00")),
          build("v1", at("09:00:00")),
          build("v0", at("08:00:00")),
        ],
        recentDeployments: [
          deployment("v2", "success", { createdAt: at("10:00:00") }),
          deployment("v1", "success", { createdAt: at("09:10:00") }),
          deployment("v0", "success", { createdAt: at("08:10:00") }),
        ],
      }),
    ]);
    await openRowMenu("v2");
    expect(menuItems()).toEqual(["Redeploy", "View log", "View pipeline"]);
    await closeRowMenu("v2");

    await openRowMenu("v1");
    expect(menuItems()).toContain("Roll back to this");
    await closeRowMenu("v1");

    await openRowMenu("v0");
    expect(menuItems()).toContain("Deploy this version");
    expect(menuItems()).not.toContain("Roll back to this");
  });

  it("View pipeline opens the build's pipeline in a new tab", async () => {
    await mount([liveTarget()]);
    await openRowMenu("v2");
    const link = menuItem("View pipeline");
    expect(link?.tagName).toBe("A");
    expect(link?.getAttribute("href")).toBe("https://ci.example.com/v2");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
    expect(link?.getAttribute("aria-label")).toContain(d.opensInNewTab);
  });

  it("deploy from the menu confirms first and then deploys that tag", async () => {
    await mount([
      target({
        currentTag: "v3",
        currentStatus: "success",
        previousTag: "v2",
        recentBuilds: [
          build("v3", at("09:50:00")),
          build("v2", at("09:00:00")),
        ],
        recentDeployments: [
          deployment("v3", "success", { createdAt: at("10:00:00") }),
          deployment("v2", "success", { createdAt: at("09:10:00") }),
        ],
      }),
    ]);
    await openRowMenu("v2");
    await act(async () => menuItem("Deploy this version")?.click());
    await settle();
    expect(state.deployTag).not.toHaveBeenCalled();
    expect(alertDialog()?.textContent).toContain(
      d.deployConfirmTitle.replace("{tag}", "v2")
    );
    await act(async () => buttonIn(alertDialog(), d.deploy)?.click());
    await settle();
    expect(state.deployTag).toHaveBeenCalledWith("a", "v2");
  });

  it("roll back from the menu keeps the destructive confirmation", async () => {
    await mount([liveTarget()]);
    await openRowMenu("v1");
    await act(async () => menuItem("Roll back to this")?.click());
    await settle();
    const confirm = buttonIn(alertDialog(), "Roll back to v1");
    expect(confirm?.className).toContain("bg-destructive/10");
    await act(async () => confirm?.click());
    await settle();
    expect(state.rollbackTarget).toHaveBeenCalledWith("a");
  });

  it("Mark release is reachable from the menu of a released jar row", async () => {
    const source = { branch: "main", commitSha: "0123456789abcdef" };
    await mount([
      liveTarget({
        kind: "jar",
        jarName: "app.jar",
        systemdUnit: "app",
        recentDeployments: [
          deployment("v2", "success", {
            createdAt: at("10:00:00"),
            build: source,
          }),
          deployment("v1", "success", { createdAt: at("09:10:00") }),
        ],
      }),
    ]);
    await openRowMenu("v2");
    await act(async () => menuItem(d.markRelease)?.click());
    await settle();
    expect(document.querySelector("[role=dialog]")?.textContent).toContain(
      "main · 0123456"
    );
  });

  it("deploy-only rows: Deploy this version disabled with its reason", async () => {
    const other = { branch: "release", commitSha: "fedcba9876543210" };
    await mount([
      target({
        currentTag: "v2",
        currentStatus: "success",
        previousTag: "v1",
        recentDeployments: [
          deployment("v2", "success", {
            createdAt: at("10:00:00"),
            build: other,
          }),
          deployment("v1", "success", {
            createdAt: at("09:00:00"),
            build: other,
          }),
        ],
      }),
    ]);
    const empty = d.buildsEmpty.replace("{branch}", "main");
    expect(
      [...container.querySelectorAll('[data-slot="card"] p')].some(
        (p) => p.textContent === empty
      )
    ).toBe(false);
    expect(rowTags()).toEqual(["v2", "v1"]);
    const header = container.querySelector('[data-slot="card-header"]');
    expect(header?.textContent).not.toContain(
      d.deployLatest.split("{tag}")[0]?.trim()
    );

    await openRowMenu("v1");
    const deploy = menuItem(d.deployThis);
    expect(deploy?.getAttribute("aria-disabled")).toBe("true");
    expect(deploy?.textContent).toContain(
      d.notBuilt.replace("{branch}", "main")
    );
    expect(menuItems()).toContain(d.rollbackThis);
  });

  it("a held row turns into Deploying when the lock is released", async () => {
    const withV3 = (v3: ReturnType<typeof deployment>) =>
      liveTarget({
        recentBuilds: [
          build("v3", at("10:02:00")),
          build("v2", at("09:50:00")),
          build("v1", at("09:00:00")),
        ],
        recentDeployments: [
          v3,
          deployment("v2", "success", { createdAt: at("10:00:00") }),
          deployment("v1", "success", { createdAt: at("09:10:00") }),
        ],
      });
    await mount([
      withV3(
        deployment("v3", "held", {
          id: "d-v3",
          createdAt: at("10:03:00"),
          runId: null,
          startedAt: null,
          finishedAt: null,
        })
      ),
    ]);
    expect(row("v3").dataset.status).toBe("held");
    expect(statusOf("v3")?.textContent).toContain(d.row.held);
    expect(buttonIn(row("v3"), d.viewLog)).toBeUndefined();
    await openRowMenu("v3");
    expect(menuItems()).not.toContain(d.viewLog);
    await closeRowMenu("v3");

    await render([
      withV3(
        deployment("v3", "queued", {
          id: "d-v3",
          createdAt: at("10:03:00"),
          runId: "r1",
          startedAt: null,
          finishedAt: null,
        })
      ),
    ]);
    expect(row("v3").dataset.status).toBe("queued");
    expect(statusOf("v3")?.textContent).toContain(d.row.queued);
    await openRowMenu("v3");
    expect(menuItems()).toContain(d.viewLog);
  });

  it("Deploying shows elapsed time and View log, without step text", async () => {
    await mount([
      liveTarget({
        recentBuilds: [
          build("v3", at("10:02:00")),
          build("v2", at("09:50:00")),
        ],
        recentDeployments: [
          deployment("v3", "running", {
            createdAt: at("10:03:55"),
            startedAt: new Date(NOW.getTime() - 65_000),
            finishedAt: null,
          }),
          deployment("v2", "success", { createdAt: at("10:00:00") }),
        ],
      }),
    ]);
    expect(row("v3").dataset.status).toBe("deploying");
    expect(statusOf("v3")?.textContent).toContain("Deploying · 1m 5s");
    const viewLog = buttonIn(row("v3"), d.viewLog);
    await act(async () => viewLog?.click());
    expect(container.textContent).toContain("run:run-v3");
  });

  it("history lists every deployment of a tag with who and when", async () => {
    await mount([
      liveTarget({
        recentDeployments: [
          deployment("v2", "success", {
            id: "d3",
            createdAt: at("10:00:00"),
            userName: "Ada Example",
          }),
          deployment("v2", "failed", {
            id: "d2",
            createdAt: at("09:40:00"),
            userName: "Bo Example",
          }),
          deployment("v2", "success", {
            id: "d1",
            createdAt: at("09:20:00"),
            userName: "Cy Example",
            trigger: "rollback",
          }),
          deployment("v1", "success", { createdAt: at("09:10:00") }),
        ],
      }),
    ]);
    const trigger = [...row("v2").querySelectorAll("button")].find(
      (b) => b.textContent === "2 earlier deploys"
    );
    expect(trigger).toBeDefined();
    await act(async () => trigger?.click());
    await settle();
    const entries = row("v2").querySelectorAll('[data-slot="history-entry"]');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.textContent).toContain("Bo Example");
    expect(entries[1]?.textContent).toContain("Cy Example");
    expect(entries[1]?.textContent).toContain(d.trigger.rollback);
    expect(row("v1").textContent).not.toContain("earlier deploy");
  });

  it("Show more reveals 20 more rows, then hides", async () => {
    const builds = Array.from({ length: 35 }, (_, i) =>
      build(`b${i}`, new Date(at("10:00:00").getTime() - i * 60_000))
    );
    await mount([target({ recentBuilds: builds })]);
    const more = () =>
      [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.startsWith("Show ")
      );
    expect(rows()).toHaveLength(10);
    expect(more()?.textContent).toBe("Show 20 more");
    await act(async () => more()?.click());
    expect(rows()).toHaveLength(30);
    expect(more()?.textContent).toBe("Show 5 more");
    await act(async () => more()?.click());
    expect(rows()).toHaveLength(35);
    expect(more()).toBeUndefined();
  });

  it("menu trigger has an accessible name per tag", async () => {
    await mount([liveTarget()]);
    expect(menuTrigger("v2")).not.toBeNull();
    expect(menuTrigger("v1")).not.toBeNull();
    expect(row("v2").contains(menuTrigger("v2"))).toBe(true);
  });
});
