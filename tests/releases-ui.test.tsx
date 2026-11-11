// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DialogProvider } from "@/components/dialog-provider";
import { ProjectRoleProvider } from "@/components/project-role";
import { locales } from "@/i18n/locales";
import { ApiError } from "@/web/api/client";
import messages from "../messages/en.json";

const api = vi.hoisted(() => ({
  createRelease: vi.fn(),
  listProjectReleases: vi.fn(),
  orgRole: "admin" as string,
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/web/api/apps", () => ({
  startComponentBuild: vi.fn(),
  getActiveBuild: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/web/api/session", () => ({
  useMe: () => ({ orgRole: api.orgRole }),
}));
vi.mock("@/web/api/releases", async (importOriginal) => {
  const { queryOptions } = await import("@tanstack/react-query");
  return {
    ...(await importOriginal<object>()),
    createRelease: api.createRelease,
    deleteRelease: vi.fn(),
    listProjectReleasesQuery: (projectId: string) =>
      queryOptions({
        queryKey: ["releases", "list", projectId],
        queryFn: () => api.listProjectReleases(projectId),
      }),
  };
});
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
import { ReleasesList } from "../web/routes/$locale/_app/-components/releases/releases-list";

type Role = "viewer" | "qa" | "engineer";

let root: Root;
let container: HTMLDivElement;

async function render(ui: React.ReactNode, role: Role) {
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
              <Suspense fallback={null}>{ui}</Suspense>
            </ProjectRoleProvider>
          </DialogProvider>
        </IntlProvider>
      </QueryClientProvider>
    )
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
  api.orgRole = "admin";
});

function deployment(
  id: string,
  status: string,
  build: { branch: string; commitSha: string } | null = {
    branch: "feature/risk-profile",
    commitSha: "0123456789abcdef",
  }
) {
  return {
    id,
    tag: `v-${id}`,
    status,
    trigger: "manual",
    runId: null,
    userName: "Romi",
    autoUser: null,
    triggeredBy: null,
    createdAt: new Date().toISOString(),
    build,
  };
}

function target(kind: string, deployments: ReturnType<typeof deployment>[]) {
  return {
    id: "t1",
    kind,
    componentKey: "hris-be",
    appKey: "hris",
    sourceBranch: "main",
    serverId: "s1",
    deployDir: "/srv/hris",
    jarName: "app.jar",
    systemdUnit: "hris.service",
    services: ["backend"],
    autoDeploy: false,
    deployNextBuild: false,
    currentTag: null,
    currentStatus: null,
    previousTag: null,
    recentBuilds: [],
    recentDeployments: deployments,
  };
}

async function mountDeploys(
  t: ReturnType<typeof target>,
  role: Role = "engineer"
) {
  await render(
    <DeploysClient
      environment={{ id: "e1", ownerId: null, services: [] } as never}
      targets={[t as never]}
      settingsHref="/s"
      addTargetHref="/a"
    />,
    role
  );
}

const markButtons = () =>
  [...container.querySelectorAll("button")].filter(
    (b) => b.textContent === "Mark as release"
  );

describe("Mark as release on the Deploys page", () => {
  it("shows an engineer the action on a success jar row only", async () => {
    await mountDeploys(
      target("jar", [deployment("1", "success"), deployment("2", "failed")])
    );
    expect(markButtons()).toHaveLength(1);
  });

  it("offers it on a static target too", async () => {
    await mountDeploys(target("static", [deployment("1", "success")]));
    expect(markButtons()).toHaveLength(1);
  });

  it("does not offer it on a compose target", async () => {
    await mountDeploys(target("compose", [deployment("1", "success")]));
    expect(markButtons()).toHaveLength(0);
  });

  it("does not offer it to a QA user or a viewer", async () => {
    await mountDeploys(target("jar", [deployment("1", "success")]), "qa");
    expect(markButtons()).toHaveLength(0);
    act(() => root.unmount());
    container.remove();
    await mountDeploys(target("jar", [deployment("1", "success")]), "viewer");
    expect(markButtons()).toHaveLength(0);
  });

  it("does not offer it on a success row whose build is unknown", async () => {
    await mountDeploys(target("jar", [deployment("1", "success", null)]));
    expect(markButtons()).toHaveLength(0);
  });

  it("shows the source branch and short commit in the dialog", async () => {
    await mountDeploys(target("jar", [deployment("1", "success")]));
    await act(async () => markButtons()[0]?.click());
    const dialog = document.querySelector("[role=dialog]");
    expect(dialog?.textContent).toContain("feature/risk-profile · 0123456");
    expect(dialog?.textContent).not.toContain("0123456789abcdef");
  });

  async function openDialogAndSubmit(version: string) {
    await act(async () => markButtons()[0]?.click());
    const input = document.querySelector<HTMLInputElement>(
      'input[name="version"]'
    );
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      setter?.call(input, version);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = [...document.querySelectorAll("button")].find(
      (b) => b.type === "submit"
    );
    await act(async () => {
      submit?.click();
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it("posts the release and toasts that it is being prepared", async () => {
    api.createRelease.mockResolvedValue({ releaseId: "r1", runId: "run1" });
    await mountDeploys(target("jar", [deployment("1", "success")]));
    await openDialogAndSubmit("1.4.0");
    expect(api.createRelease).toHaveBeenCalledWith("e1", {
      deploymentId: "1",
      version: "1.4.0",
    });
    expect(api.toast.success).toHaveBeenCalledWith("Preparing release…");
  });

  it("shows a taken version on the Version field", async () => {
    api.createRelease.mockRejectedValue(
      new ApiError(409, "taken", "releaseVersionTaken")
    );
    await mountDeploys(target("jar", [deployment("1", "success")]));
    await openDialogAndSubmit("1.4.0");
    expect(document.body.textContent).toContain(
      "This version name is already used for this component."
    );
    expect(api.toast.error).not.toHaveBeenCalled();
  });
});

function release(extra: Record<string, unknown> = {}) {
  return {
    id: "r1",
    componentKey: "hris-be",
    version: "1.0.0",
    notes: null,
    status: "ready",
    error: null,
    branch: "main",
    tag: "v1",
    commitSha: "abcdef1234567890",
    environmentName: "QA",
    createdByName: "Romi",
    createdAt: new Date().toISOString(),
    sizeBytes: 2048,
    fileName: "hris-be_1.0.0.jar",
    ...extra,
  };
}

async function mountList(rows: ReturnType<typeof release>[], role: Role) {
  api.listProjectReleases.mockResolvedValue({
    releases: rows,
    totalBytes: rows.reduce((n, r) => n + (r.sizeBytes ?? 0), 0),
  });
  await render(<ReleasesList projectId="p1" />, role);
}

const downloadLinks = () =>
  [...container.querySelectorAll("a")].filter(
    (a) => a.textContent === "Download"
  );

describe("Releases page", () => {
  it("groups rows by version and renders the total size", async () => {
    await mountList(
      [
        release({ id: "r1", version: "2.0.0" }),
        release({ id: "r2", version: "2.0.0", componentKey: "hris-fe" }),
        release({ id: "r3", version: "1.0.0", sizeBytes: 1024 }),
      ],
      "engineer"
    );
    const titles = [...container.querySelectorAll("[data-slot=card-title]")];
    expect(titles.map((n) => n.textContent)).toEqual([
      "Version 2.0.0",
      "Version 1.0.0",
    ]);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(container.textContent).toContain("Total size");
    expect(container.textContent).toContain("5 KB");
  });

  it("shows each release's source branch, commit and tag", async () => {
    await mountList([release({ tag: "hris-be-main-42" })], "engineer");
    const row = container.querySelector("tbody tr");
    expect(row?.textContent).toContain("main · abcdef1");
    expect(row?.textContent).toContain("hris-be-main-42");
  });

  it("links Download to the release only when it is ready", async () => {
    await mountList(
      [
        release({ id: "r1" }),
        release({ id: "r2", status: "preparing", sizeBytes: null }),
        release({ id: "r3", status: "failed", error: "boom", sizeBytes: null }),
      ],
      "engineer"
    );
    const links = downloadLinks();
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/api/releases/r1/download");
    expect(container.textContent).toContain("Preparing");
    expect(container.textContent).toContain("boom");
  });

  it("gives a QA user no Download", async () => {
    await mountList([release()], "qa");
    expect(downloadLinks()).toHaveLength(0);
  });

  it("offers Delete to admins only", async () => {
    await mountList([release()], "engineer");
    const hasDelete = () =>
      [...container.querySelectorAll("button")].some(
        (b) => b.textContent === "Delete"
      );
    expect(hasDelete()).toBe(true);
    act(() => root.unmount());
    container.remove();
    api.orgRole = "member";
    await mountList([release()], "engineer");
    expect(hasDelete()).toBe(false);
  });
});

describe("release activity messages", () => {
  const activity = (locale: string): Record<string, string> =>
    JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")).activity;
  const KEYS = ["releaseCreated", "releaseDownloaded", "releaseDeleted"];

  it("every locale carries the params of each release event", () => {
    for (const locale of locales) {
      for (const key of KEYS) {
        const text = activity(locale)[key] ?? "";
        for (const param of [
          "{actor}",
          "{project}",
          "{component}",
          "{version}",
        ]) {
          expect(text, `${locale}.${key}`).toContain(param);
        }
      }
    }
  });

  it("the activity page renders the three actions", () => {
    const page = readFileSync(
      "web/routes/$locale/_app/admin.activity.tsx",
      "utf8"
    );
    for (const action of ["created", "downloaded", "deleted"]) {
      expect(page).toContain(`case "release.${action}"`);
    }
  });
});
