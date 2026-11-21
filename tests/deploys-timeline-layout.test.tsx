// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { DialogProvider } from "@/components/dialog-provider";
import { ProjectRoleProvider } from "@/components/project-role";
import arMessages from "../messages/ar.json";
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
import { DeploysPending } from "../web/routes/$locale/_app/-components/env/deploys/deploys-pending";

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
  role: "viewer" | "engineer" = "engineer",
  extra: {
    locale?: "en" | "ar";
    refreshFailed?: boolean;
    onRetry?: () => void;
    retrying?: boolean;
  } = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider
          locale={extra.locale ?? "en"}
          messages={(extra.locale === "ar" ? arMessages : messages) as never}
          timeZone="UTC"
          now={NOW}
        >
          <DialogProvider>
            <ProjectRoleProvider role={role}>
              <DeploysClient
                environment={environment}
                targets={targets as never}
                settingsHref="/s"
                addTargetHref="/a"
                refreshFailed={extra.refreshFailed}
                onRetry={extra.onRetry}
                retrying={extra.retrying}
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
  role: "viewer" | "engineer" = "engineer",
  extra: Parameters<typeof render>[2] = {}
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  if (extra.locale === "ar") {
    const host = document.createElement("div");
    host.dir = "rtl";
    document.body.append(host);
    host.append(container);
  }
  await render(targets, role, extra);
}

const buttonIn = (scope: ParentNode | null | undefined, text: string) =>
  [...(scope?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent === text
  );

const DIR = "web/routes/$locale/_app/-components/env/deploys";
const slot = (name: string, scope: ParentNode = container) =>
  scope.querySelector<HTMLElement>(`[data-slot="${name}"]`);

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("Deploy timeline layout", () => {
  it("rows stack below md and become columns from md", async () => {
    await mount([liveTarget()]);
    const first = slot("timeline-row") as HTMLElement;
    const cls = [...first.classList];
    expect(cls).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(cls.some((c) => c.startsWith("md:grid-cols-["))).toBe(true);
    const time = slot("row-time", first);
    expect(time?.classList.contains("hidden")).toBe(true);
    expect(time?.classList.contains("md:block")).toBe(true);
    expect(slot("row-received", first)?.classList.contains("md:hidden")).toBe(
      true
    );
  });

  it("a tag that fits is no tab stop and no extra group", async () => {
    await mount([liveTarget()]);
    const scrollers = container.querySelectorAll('[data-slot="tag-scroll"]');
    expect(scrollers.length).toBeGreaterThan(0);
    for (const scroller of scrollers) {
      expect(scroller.hasAttribute("tabindex")).toBe(false);
      expect(scroller.hasAttribute("role")).toBe(false);
      expect(scroller.hasAttribute("aria-label")).toBe(false);
    }
  });

  it("long tag sits in its own scroll wrapper", async () => {
    // happy-dom lays nothing out: make every box report an overflow.
    const proto = HTMLElement.prototype;
    Object.defineProperty(proto, "scrollWidth", {
      configurable: true,
      get: () => 500,
    });
    Object.defineProperty(proto, "clientWidth", {
      configurable: true,
      get: () => 100,
    });
    onTestFinished(() => {
      Reflect.deleteProperty(proto, "scrollWidth");
      Reflect.deleteProperty(proto, "clientWidth");
    });
    const longTag = "v".repeat(120);
    const longMessage = `${"m".repeat(500)}\n\nbody`;
    await mount([
      target({
        recentBuilds: [
          build(longTag, at("09:00:00"), { commitMessage: longMessage }),
        ],
      }),
    ]);
    const scroller = slot("row-tag")?.closest<HTMLElement>(
      '[data-slot="tag-scroll"]'
    );
    expect(scroller).not.toBeNull();
    expect(scroller?.classList.contains("overflow-x-auto")).toBe(true);
    expect(scroller?.getAttribute("tabindex")).toBe("0");
    expect(scroller?.getAttribute("role")).toBe("group");
    expect(scroller?.getAttribute("aria-label")).toBe(longTag);
    for (
      let el = scroller?.parentElement;
      el && el !== container;
      el = el.parentElement
    ) {
      expect(el.classList.contains("overflow-x-auto")).toBe(false);
    }
    // The timeline's model keeps only the first line of the message.
    const message = container.querySelector<HTMLElement>("span.truncate");
    expect(message?.classList.contains("truncate")).toBe(true);
    expect(message?.getAttribute("title")).toBe("m".repeat(500));
  });

  it("restores the full sha as the commit title", async () => {
    await mount([liveTarget()]);
    const code = slot("row-commit")?.querySelector("code");
    expect(code?.getAttribute("title")).toBe("v2abcdef0123");
  });

  it("timeline sources use logical properties only", () => {
    for (const file of [
      "timeline.tsx",
      "target-header.tsx",
      "row-menu.tsx",
      "deploys-pending.tsx",
    ]) {
      const source = readFileSync(join(process.cwd(), DIR, file), "utf8");
      expect(source, file).not.toMatch(
        /\b(?:ml|mr|pl|pr|left|right)-[\w[]|\btext-(?:left|right)\b/
      );
    }
  });

  it("renders right-to-left in ar", async () => {
    await mount([liveTarget()], "engineer", { locale: "ar" });
    const label = arMessages.deploys.rowActionsLabel.replace("{tag}", "v2");
    expect(
      container.querySelector(`button[aria-label="${label}"]`)
    ).not.toBeNull();
  });

  it("icon-only controls have accessible names", async () => {
    await mount([liveTarget()]);
    const unnamed = [...container.querySelectorAll("button, a")].filter(
      (el) => !el.textContent?.trim() && !el.getAttribute("aria-label")?.trim()
    );
    expect(unnamed).toEqual([]);
  });

  it("no positive tabIndex", async () => {
    await mount([liveTarget()]);
    const values = [...container.querySelectorAll("[tabindex]")].map((el) =>
      el.getAttribute("tabindex")
    );
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(["0", "-1"]).toContain(v);
  });

  it("refresh error shows an inline alert with Try again", async () => {
    const onRetry = vi.fn();
    await mount([liveTarget()], "engineer", { refreshFailed: true, onRetry });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(d.loadFailed);
    const retry = buttonIn(alert, messages.common.tryAgain);
    await act(async () => retry?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("Try again is disabled with a spinner while the refetch runs", async () => {
    await mount([liveTarget()], "engineer", {
      refreshFailed: true,
      onRetry: vi.fn(),
      retrying: true,
    });
    const alert = container.querySelector('[role="alert"]');
    const retry = buttonIn(alert, messages.common.tryAgain);
    expect(retry?.disabled).toBe(true);
    expect(retry?.querySelector(".animate-spin")).not.toBeNull();
  });

  it("pending skeleton is shaped like the cards", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<DeploysPending />));
    const cards = container.querySelectorAll('[data-slot="card"]');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(
        card.querySelectorAll('[data-slot="timeline-row-skeleton"]')
      ).toHaveLength(5);
    }
  });

  it("moves focus to the first newly shown row after Show more", async () => {
    const builds = Array.from({ length: 12 }, (_, i) =>
      build(
        `t${String(i).padStart(2, "0")}`,
        at(`09:${String(59 - i).padStart(2, "0")}:00`)
      )
    );
    await mount([target({ recentBuilds: builds })]);
    const more = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Show ")
    );
    await act(async () => more?.click());
    await act(async () => Promise.resolve());
    const rows = container.querySelectorAll('[data-slot="timeline-row"]');
    expect(rows).toHaveLength(12);
    expect(document.activeElement).toBe(rows[10]);
    expect(rows[10]?.getAttribute("tabindex")).toBe("-1");
  });
});
