// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogProvider } from "@/components/dialog-provider";
import { ProjectRoleProvider } from "@/components/project-role";
import messages from "../messages/en.json";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/components/live-run-dialog", () => ({ LiveRunDialog: () => null }));
vi.mock(
  "../web/routes/$locale/_app/-components/env/deploys/deploy-lock",
  () => ({ DeployLockPanel: () => null, useDeployLock: () => ({}) })
);
vi.mock(
  "../web/routes/$locale/_app/-components/env/provisioning-panel",
  () => ({ ProvisioningPanel: () => null })
);

import { DeploysClient } from "../web/routes/$locale/_app/-components/env/deploys/deploys-client";

const environment = { id: "e1", ownerId: null, services: [] } as never;
const when = new Date("2026-11-12T02:00:00Z");

function build(tag: string) {
  return {
    id: `b-${tag}`,
    tag,
    commitSha: `${tag}0000000`,
    commitMessage: null,
    commitAuthorEmail: null,
    pipelineUrl: null,
    receivedAt: when,
  };
}

function deployment(tag: string, status: string, runId: string | null = null) {
  return {
    id: `d-${tag}-${status}`,
    tag,
    status,
    trigger: "manual",
    runId,
    userName: null,
    triggeredBy: null,
    build: null,
    createdAt: when,
    startedAt: when,
    finishedAt: null,
  };
}

function target(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    componentKey: `app-${id}`,
    sourceBranch: "main",
    serverId: "s1",
    deployDir: `/srv/${id}`,
    services: ["web"],
    kind: "compose",
    autoDeploy: false,
    deployNextBuild: false,
    currentTag: null,
    currentStatus: null,
    previousTag: null,
    recentBuilds: [build("new"), build("old")],
    recentDeployments: [],
    ...extra,
  };
}

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
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
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

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

const d = messages.deploys;

// The ⋯ trigger of the row of `tag` in the card of target `id`.
function menuTrigger(id: string, tag: string): HTMLButtonElement | null {
  const card = [...container.querySelectorAll('[data-slot="card"]')].find((c) =>
    c.textContent?.includes(`app-${id}`)
  );
  return (
    card?.querySelector<HTMLButtonElement>(
      `button[aria-label="${d.rowActionsLabel.replace("{tag}", tag)}"]`
    ) ?? null
  );
}

// Opens the row's menu and returns its items, then closes it again.
async function rowMenu(id: string, tag: string): Promise<HTMLElement[]> {
  const trigger = menuTrigger(id, tag);
  if (!trigger) throw new Error(`no menu for ${id}/${tag}`);
  await act(async () => trigger.click());
  await settle();
  const items = [
    ...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ];
  const snapshot = items.map((el) => el.cloneNode(true) as HTMLElement);
  await act(async () => trigger.click());
  await settle();
  return snapshot;
}

const labelled = (items: HTMLElement[], label: string) =>
  items.find((el) => el.textContent?.startsWith(label));

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("Deploy buttons while a deploy is active", () => {
  it("offers no deploy on the row being deployed", async () => {
    await mount([
      target("a", {
        currentTag: "new",
        currentStatus: "running",
        recentDeployments: [deployment("new", "running", "run-new")],
      }),
    ]);
    const items = await rowMenu("a", "new");
    expect(labelled(items, d.deployThis)).toBeUndefined();
    expect(labelled(items, d.redeploy)).toBeUndefined();
    expect(labelled(items, d.viewLog)).toBeDefined();
  });

  it("treats a queued deployment as active too", async () => {
    await mount([
      target("a", {
        recentDeployments: [deployment("new", "queued", "run-new")],
      }),
    ]);
    const items = await rowMenu("a", "new");
    expect(labelled(items, d.deployThis)).toBeUndefined();
  });

  it("keeps the other rows enabled and says they start after the running one", async () => {
    await mount([
      target("a", { recentDeployments: [deployment("new", "running")] }),
      target("b"),
    ]);
    const other = labelled(await rowMenu("a", "old"), d.deployThis);
    expect(other?.getAttribute("aria-disabled")).not.toBe("true");
    expect(other?.textContent).toBe(`${d.deployThis}${d.startsAfterRunning}`);
    const elsewhere = labelled(await rowMenu("b", "new"), d.deployThis);
    expect(elsewhere?.getAttribute("aria-disabled")).not.toBe("true");
    expect(elsewhere?.textContent).toContain(d.startsAfterRunning);
  });

  it("shows no hint when nothing is active", async () => {
    await mount([target("a")]);
    const item = labelled(await rowMenu("a", "new"), d.deployThis);
    expect(item?.getAttribute("aria-disabled")).not.toBe("true");
    expect(item?.textContent).toBe(d.deployThis);
  });

  it("offers Redeploy on the cleanly deployed tag once the deploy succeeded", async () => {
    await mount([
      target("a", {
        currentTag: "new",
        currentStatus: "success",
        recentDeployments: [deployment("new", "success")],
      }),
    ]);
    const items = await rowMenu("a", "new");
    const redeploy = labelled(items, d.redeploy);
    expect(redeploy?.getAttribute("aria-disabled")).not.toBe("true");
    expect(labelled(items, d.deployThis)).toBeUndefined();
  });
});
