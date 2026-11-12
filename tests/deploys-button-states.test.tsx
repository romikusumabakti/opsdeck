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

function deployment(tag: string, status: string) {
  return {
    id: `d-${tag}-${status}`,
    tag,
    status,
    trigger: "manual",
    runId: null,
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
    appKey: "app",
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

// The deploy button on the build row of `tag` in the card of target `id`.
function rowButton(id: string, tag: string): HTMLButtonElement {
  const card = [...container.querySelectorAll('[data-slot="card"]')].find((c) =>
    c.textContent?.includes(`app-${id}`)
  );
  const row = [...(card?.querySelectorAll("tr") ?? [])].find(
    (r) => r.querySelector("td")?.textContent === tag
  );
  const button = row?.querySelector("button");
  if (!button) throw new Error(`no button for ${id}/${tag}`);
  return button;
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Deploy buttons while a deploy is active", () => {
  it("disables the row being deployed and labels it Deploying…", async () => {
    await mount([
      target("a", {
        currentTag: "new",
        currentStatus: "running",
        recentDeployments: [deployment("new", "running")],
      }),
    ]);
    const button = rowButton("a", "new");
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe(messages.deploys.deploying);
  });

  it("treats a queued deployment as active too", async () => {
    await mount([
      target("a", { recentDeployments: [deployment("new", "queued")] }),
    ]);
    expect(rowButton("a", "new").disabled).toBe(true);
  });

  it("keeps the other rows enabled and says they start after the running one", async () => {
    await mount([
      target("a", { recentDeployments: [deployment("new", "running")] }),
      target("b"),
    ]);
    const other = rowButton("a", "old");
    expect(other.disabled).toBe(false);
    expect(other.textContent).toBe(messages.deploys.deploy);
    const elsewhere = rowButton("b", "new");
    expect(elsewhere.disabled).toBe(false);
    // The hint wraps the button in a tooltip trigger.
    expect(elsewhere.parentElement?.tagName).toBe("SPAN");
  });

  it("shows no hint when nothing is active", async () => {
    await mount([target("a")]);
    const button = rowButton("a", "new");
    expect(button.disabled).toBe(false);
    expect(button.parentElement?.tagName).toBe("TD");
  });

  it("keeps the cleanly deployed tag disabled once the deploy succeeded", async () => {
    await mount([
      target("a", {
        currentTag: "new",
        currentStatus: "success",
        recentDeployments: [deployment("new", "success")],
      }),
    ]);
    expect(rowButton("a", "new").disabled).toBe(true);
    expect(rowButton("a", "new").textContent).toBe(messages.deploys.deploy);
  });

  it("shows the running status next to the current tag", async () => {
    await mount([
      target("a", {
        currentTag: "new",
        currentStatus: "running",
        recentDeployments: [deployment("new", "running")],
      }),
    ]);
    const current = [...container.querySelectorAll("div")].find(
      (d) =>
        d.firstElementChild?.textContent === messages.deploys.currentTag &&
        d.children.length > 1
    );
    expect(current?.textContent).toContain(messages.deploys.status.running);
  });
});
