// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogProvider } from "@/components/dialog-provider";
import { ProjectRoleProvider } from "@/components/project-role";
import messages from "../messages/en.json";

const api = vi.hoisted(() => ({
  startComponentBuild: vi.fn(),
  getActiveBuild: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/web/api/apps", () => ({
  startComponentBuild: api.startComponentBuild,
  getActiveBuild: api.getActiveBuild,
}));
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
const PIPELINE = "https://ci.example.test/repos/1/pipeline/14";

function target(extra: Record<string, unknown> = {}) {
  return {
    id: "t1",
    componentKey: "hris-be",
    appKey: "hris",
    sourceBranch: "feature-x",
    serverId: "s1",
    deployDir: "/srv/hris",
    services: ["backend"],
    autoDeploy: true,
    deployNextBuild: false,
    currentTag: null,
    currentStatus: null,
    previousTag: null,
    recentBuilds: [],
    recentDeployments: [],
    ...extra,
  };
}

let root: Root;
let container: HTMLDivElement;

async function mount(
  t: Record<string, unknown>,
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
                targets={[t as never]}
                settingsHref="/s"
                addTargetHref="/a"
              />
            </ProjectRoleProvider>
          </DialogProvider>
        </IntlProvider>
      </QueryClientProvider>
    )
  );
  // Let the active-build query resolve and render.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function startButton(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (b) => b.textContent === messages.deploys.startBuild
  );
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("Deploys page build status for a branch with no builds", () => {
  it("shows the running pipeline with its link instead of Start build", async () => {
    api.getActiveBuild.mockResolvedValue({ number: 14, url: PIPELINE });
    await mount(target());
    expect(api.getActiveBuild).toHaveBeenCalledWith(
      "hris",
      "hris-be",
      "feature-x"
    );
    expect(startButton()).toBeUndefined();
    const link = container.querySelector(`a[href="${PIPELINE}"]`);
    expect(link?.textContent).toContain("Build #14 running…");
  });

  it("shows the running pipeline without a link when its URL is unknown", async () => {
    api.getActiveBuild.mockResolvedValue({ number: 14, url: null });
    await mount(target());
    expect(startButton()).toBeUndefined();
    expect(container.textContent).toContain("Build #14 running…");
    expect(container.querySelector(`a[href="${PIPELINE}"]`)).toBeNull();
  });

  it("shows a viewer the running pipeline too", async () => {
    api.getActiveBuild.mockResolvedValue({ number: 14, url: PIPELINE });
    await mount(target(), "viewer");
    expect(container.textContent).toContain("Build #14 running…");
  });

  it("offers Start build when nothing is running", async () => {
    api.getActiveBuild.mockResolvedValue(null);
    await mount(target());
    expect(startButton()).toBeDefined();
  });

  it("starts a build and re-reads the running pipeline", async () => {
    api.getActiveBuild.mockResolvedValue(null);
    api.startComponentBuild.mockResolvedValue({ number: 15 });
    await mount(target());
    api.getActiveBuild.mockResolvedValue({ number: 15, url: null });
    await act(async () => startButton()?.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(api.startComponentBuild).toHaveBeenCalledWith(
      "hris",
      "hris-be",
      "feature-x"
    );
    expect(api.toast.success).toHaveBeenCalledWith("Build 15 started");
    expect(container.textContent).toContain("Build #15 running…");
    expect(startButton()).toBeUndefined();
  });

  it("shows the refusal and keeps the button", async () => {
    api.getActiveBuild.mockResolvedValue(null);
    api.startComponentBuild.mockRejectedValue(new Error("Forbidden"));
    await mount(target());
    await act(async () => startButton()?.click());
    expect(api.toast.error).toHaveBeenCalledWith("Forbidden");
    expect(startButton()?.disabled).toBe(false);
  });

  it("says the build deploys when it lands when auto-deploy is on", async () => {
    api.getActiveBuild.mockResolvedValue(null);
    await mount(target({ autoDeploy: true }));
    expect(startButton()?.title).toBe(
      "Build feature-x now; it deploys when it lands."
    );
  });

  it("says the build deploys when it lands when the next build is flagged", async () => {
    api.getActiveBuild.mockResolvedValue(null);
    await mount(target({ autoDeploy: false, deployNextBuild: true }));
    expect(startButton()?.title).toBe(
      "Build feature-x now; it deploys when it lands."
    );
  });

  it("says to deploy the build by hand when auto-deploy is off", async () => {
    api.getActiveBuild.mockResolvedValue(null);
    await mount(target({ autoDeploy: false }));
    expect(startButton()?.title).toBe(
      "Build feature-x now; it shows here when done, then deploy it."
    );
  });

  it("shows nothing and keeps Start build when the status cannot be read", async () => {
    api.getActiveBuild.mockRejectedValue(new Error("boom"));
    await mount(target());
    expect(startButton()).toBeDefined();
  });
});

describe("Deploy button of the deployed build", () => {
  const build = {
    id: "b1",
    tag: "abc1234",
    commitSha: "abc1234def",
    commitMessage: null,
    commitAuthorEmail: null,
    receivedAt: new Date().toISOString(),
    pipelineUrl: null,
  };

  it("is disabled and explains why", async () => {
    api.getActiveBuild.mockResolvedValue(null);
    await mount(
      target({
        currentTag: "abc1234",
        currentStatus: "success",
        recentBuilds: [build],
      })
    );
    const deploy = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === messages.deploys.deploy
    );
    expect(deploy?.disabled).toBe(true);
    const trigger = deploy?.closest('[data-slot="tooltip-trigger"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(
        new PointerEvent("pointerenter", { bubbles: true })
      );
      trigger?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      trigger?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(document.body.textContent).toContain(
      messages.deploys.alreadyDeployed
    );
  });

  it("stays enabled for another build", async () => {
    api.getActiveBuild.mockResolvedValue(null);
    await mount(
      target({
        currentTag: "zzz9999",
        currentStatus: "success",
        recentBuilds: [build],
      })
    );
    const deploy = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === messages.deploys.deploy
    );
    expect(deploy?.disabled).toBe(false);
    expect(deploy?.closest('[data-slot="tooltip-trigger"]')).toBeNull();
  });
});
