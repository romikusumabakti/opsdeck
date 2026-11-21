// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogProvider } from "@/components/dialog-provider";
import { ProjectRoleProvider } from "@/components/project-role";
import messages from "../messages/en.json";

type Lock = {
  lockedBy: { name: string } | null;
  reason: string;
  expiresAt: string;
};

const state = vi.hoisted(() => ({
  lock: null as Lock | null,
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
    useDeployLock: () => ({ data: { lock: state.lock } }),
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

function build(tag: string, receivedAt: Date, extra = {}) {
  return {
    id: `b-${tag}`,
    tag,
    commitSha: `${tag}abcdef0123`,
    commitMessage: null,
    commitAuthorEmail: null,
    pipelineUrl: `https://ci.example.com/${tag}`,
    receivedAt,
    ...extra,
  };
}

function deployment(
  tag: string,
  status: string,
  o: { createdAt?: Date; finishedAt?: Date | null; runId?: string | null } = {}
) {
  const createdAt = o.createdAt ?? at("09:00:00");
  return {
    id: `d-${tag}-${status}`,
    tag,
    status,
    trigger: "manual",
    runId: o.runId === undefined ? `run-${tag}` : o.runId,
    userName: "Ada Example",
    triggeredBy: null,
    autoUser: null,
    build: null,
    createdAt,
    startedAt: createdAt,
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

const failedTarget = () =>
  target({
    currentTag: "v2",
    currentStatus: "failed",
    previousTag: "v1",
    recentBuilds: [
      build("v3", at("10:30:00")),
      build("v2", at("09:50:00")),
      build("v1", at("09:00:00")),
    ],
    recentDeployments: [
      deployment("v2", "failed", { createdAt: at("10:00:00") }),
      deployment("v1", "success", { createdAt: at("09:10:00") }),
    ],
  });

let root: Root;
let container: HTMLDivElement;

async function mount(
  targets: Record<string, unknown>[],
  role: "viewer" | "engineer" = "engineer"
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider
          locale="en"
          messages={messages}
          timeZone="UTC"
          now={at("10:05:00")}
        >
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

const header = () => {
  const el = container.querySelector('[data-slot="card-header"]');
  if (!el) throw new Error("no card header");
  return el;
};
const slot = (name: string) => header().querySelector(`[data-slot="${name}"]`);
const buttonNamed = (text: string) =>
  [...header().querySelectorAll("button")].find((b) =>
    b.textContent?.includes(text)
  );
const deployLatest = () => buttonNamed(prefix(d.deployLatest, "tag").trim());
const alertDialog = () => document.querySelector('[role="alertdialog"]');
const prefix = (message: string, arg: string) =>
  message.split(`{${arg}}`)[0] ?? "";

beforeEach(() => {
  state.lock = null;
  state.rollbackTarget.mockReset().mockResolvedValue({ runId: "run-rb" });
  state.deployTag.mockReset().mockResolvedValue({ runId: "run-dp" });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Deploy target header", () => {
  it("live focal line names the tag, who deployed it, when and how long", async () => {
    await mount([liveTarget()]);
    const focal = slot("deploy-focal");
    expect(focal?.textContent).toContain("Live: v2");
    expect(focal?.textContent).toContain("Ada Example");
    expect(focal?.textContent).toContain("1m 30s");
    const sha = focal?.querySelector("a");
    expect(sha?.getAttribute("href")).toBe("https://ci.example.com/v2");
    expect(sha?.getAttribute("target")).toBe("_blank");
    expect(sha?.getAttribute("rel")).toBe("noreferrer");
    expect(sha?.getAttribute("aria-label")).toContain(d.opensInNewTab);
    expect(sha?.textContent).toBe("v2abcde");
  });

  it("failed current: focal failure line, Deploy latest on the newer build", async () => {
    await mount([failedTarget()]);
    const focal = slot("deploy-focal");
    expect(focal?.textContent).toContain(
      prefix(d.focalFailed, "time").replace("{tag}", "v2")
    );
    expect(focal?.textContent).toContain("last good: v1");
    const livePrefix = prefix(d.focalLive, "tag").trim();
    expect(
      [...container.querySelectorAll("*")].some(
        (el) => el.textContent?.trim() === livePrefix
      )
    ).toBe(false);
    expect(container.textContent).not.toContain(`${livePrefix} v2`);
    const statuses = header().querySelectorAll('[role="status"]');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.textContent).toContain("v2");

    const button = deployLatest();
    expect(button?.textContent).toBe("Deploy latest (v3)");
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => button?.click());
    expect(alertDialog()?.textContent).toContain(
      d.deployConfirmTitle.replace("{tag}", "v3")
    );
  });

  it("a failed later deploy shows one failure line with View log, and no badge in the title", async () => {
    await mount([
      liveTarget({
        currentTag: "v1",
        previousTag: null,
        recentBuilds: [
          build("v2", at("09:50:00")),
          build("v1", at("09:00:00")),
        ],
        recentDeployments: [
          deployment("v2", "failed", { createdAt: at("10:00:00") }),
          deployment("v1", "success", { createdAt: at("09:10:00") }),
        ],
      }),
    ]);
    const failures = header().querySelectorAll('[data-slot="deploy-failure"]');
    expect(failures).toHaveLength(1);
    const failure = failures[0];
    expect(failure?.getAttribute("role")).toBe("status");
    expect(failure?.textContent).toContain(
      prefix(d.failureLine, "time").replace("{tag}", "v2")
    );
    const viewLog = [...(failure?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === d.viewLog
    );
    await act(async () => viewLog?.click());
    expect(container.textContent).toContain("run:run-v2");
    const title = header().querySelector('[data-slot="card-title"]');
    expect(title?.querySelector('[data-variant="destructive"]')).toBeNull();
  });

  it("Deploy latest is disabled with a visible reason when the newest build is live", async () => {
    await mount([liveTarget()]);
    const button = deployLatest();
    expect(button?.textContent).toBe("Deploy latest (v2)");
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    const reason = slot("deploy-actions-reason");
    expect(reason?.textContent).toBe(d.latestIsLive.replace("{tag}", "v2"));
    expect(reason?.classList.contains("sr-only")).toBe(false);
    expect(reason?.id).toBeTruthy();
    expect(button?.getAttribute("aria-describedby")).toBe(reason?.id);
  });

  it("while the newest build deploys the focal line keeps the live tag and Deploy latest says why it waits", async () => {
    await mount([
      liveTarget({
        currentTag: "v3",
        currentStatus: "running",
        previousTag: "v2",
        recentBuilds: [
          build("v3", at("10:02:00")),
          build("v2", at("09:50:00")),
        ],
        recentDeployments: [
          deployment("v3", "running", {
            createdAt: at("10:03:00"),
            finishedAt: null,
          }),
          deployment("v2", "success", {
            createdAt: at("10:00:00"),
            finishedAt: at("10:01:30"),
          }),
        ],
      }),
    ]);
    expect(slot("deploy-focal")?.textContent).toContain("Live: v2");
    const button = deployLatest();
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(slot("deploy-actions-reason")?.textContent).toBe(d.latestDeploying);
  });

  it("Deploy latest is absent for a viewer and without builds", async () => {
    await mount([liveTarget()], "viewer");
    expect(deployLatest()).toBeUndefined();
    act(() => root.unmount());
    container.remove();
    await mount([liveTarget({ recentBuilds: [] })]);
    expect(deployLatest()).toBeUndefined();
  });

  it("rollback button keeps the destructive confirmation", async () => {
    await mount([liveTarget()]);
    const rollback = buttonNamed(d.rollbackTo.replace("{tag}", "v1"));
    expect(rollback?.disabled).toBe(false);
    await act(async () => rollback?.click());
    const confirm = [...(alertDialog()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Roll back to v1"
    );
    expect(confirm?.className).toContain("bg-destructive/10");
    await act(async () => confirm?.click());
    expect(state.rollbackTarget).toHaveBeenCalledWith("a");
  });

  it("lock chip shows who and until, the reason in its accessible description, and the reason under the disabled actions", async () => {
    state.lock = {
      lockedBy: { name: "Dana" },
      reason: "Release freeze",
      expiresAt: "2026-11-13T08:00:00Z",
    };
    await mount([failedTarget()]);
    const chip = [...header().querySelectorAll('[tabindex="0"]')].find((el) =>
      el.textContent?.includes(prefix(d.lockChip, "name"))
    );
    expect(chip?.textContent).toContain(
      prefix(d.lockChip, "time").replace("{name}", "Dana")
    );
    expect(chip?.getAttribute("tabindex")).toBe("0");
    const describedBy = chip?.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      "Release freeze"
    );
    expect(slot("deploy-actions-reason")?.textContent).toBe(
      d.lock.disabledHint.replace("{reason}", "Release freeze")
    );
    expect(deployLatest()?.getAttribute("aria-disabled")).toBe("true");
    expect(
      buttonNamed(d.rollbackTo.replace("{tag}", "v1"))?.getAttribute(
        "aria-disabled"
      )
    ).toBe("true");
  });

  it("subtitle wraps instead of truncating", async () => {
    await mount([liveTarget()]);
    const description = slot("card-description");
    expect(description).not.toBeNull();
    expect(description?.classList.contains("truncate")).toBe(false);
  });
});
