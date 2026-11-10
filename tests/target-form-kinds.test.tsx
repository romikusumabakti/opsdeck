// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Form } from "@/components/ui/form";
import messages from "../messages/en.json";

const SERVER = "0197f3a0-1b2c-7def-8000-0123456789c1";
const ENGINEER = "engineer" as const;
const ENV = "0197f3a0-1b2c-7def-8000-0123456789e1";

const api = vi.hoisted(() => ({
  createDeployTarget: vi.fn(),
  getActiveBuild: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  apps: [] as unknown[],
}));
vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/web/api/deploys", () => ({
  createDeployTarget: api.createDeployTarget,
  updateDeployTarget: vi.fn(),
}));
vi.mock("@/web/api/apps", () => ({
  listAppsQuery: () => ({ queryKey: ["apps"], queryFn: async () => api.apps }),
  getActiveBuild: api.getActiveBuild,
  startComponentBuild: vi.fn(),
}));
vi.mock("@/web/api/variables", () => ({ setEnvFileManaged: vi.fn() }));
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

import { DialogProvider } from "@/components/dialog-provider";
import { ProjectRoleProvider } from "@/components/project-role";
import { DeploysClient } from "../web/routes/$locale/_app/-components/env/deploys/deploys-client";
import { TargetFormDialog } from "../web/routes/$locale/_app/-components/env/deploys/target-form-dialog";
import { SourceDeployTab } from "../web/routes/$locale/_app/-components/env/settings/source-deploy-tab";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(ui: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <DialogProvider>
            <ProjectRoleProvider role={ENGINEER}>{ui}</ProjectRoleProvider>
          </DialogProvider>
        </IntlProvider>
      </QueryClientProvider>
    );
  });
  await settle();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  api.apps = [];
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

type FormProps = React.ComponentProps<typeof Form>;
const f = messages.deploys.form;
const field = (name: string) =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
const hasLabel = (text: string) =>
  [...document.querySelectorAll("label")].some(
    (l) => l.textContent?.trim() === text
  );

async function type(name: string, value: string) {
  const input = field(name);
  if (!input) throw new Error(`no input ${name}`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function pickKind(label: string) {
  const radio = [...document.querySelectorAll<HTMLElement>('[role="radio"]')]
    .map((el) => el.closest("label") ?? el)
    .find((el) => el.textContent?.trim() === label);
  const target = radio?.querySelector<HTMLElement>('[role="radio"]') ?? radio;
  if (!target) throw new Error(`no kind ${label}`);
  await act(async () => target.click());
  await settle();
}

const dialog = () => (
  <TargetFormDialog
    open
    onOpenChange={() => {}}
    environment={{ id: ENV, appId: null }}
    servers={[{ id: SERVER, name: ".56.129" }]}
  />
);

const APP = "0197f3a0-1b2c-7def-8000-0123456789a1";
const checkedKind = () =>
  document
    .querySelector('[role="radio"][aria-checked="true"]')
    ?.closest("label")
    ?.textContent?.trim();

describe("the kind follows the component", () => {
  const component = (componentKey: string, artifact?: string) => ({
    componentKey,
    repoFullName: `dss/${componentKey}`,
    buildSpec: artifact
      ? { artifact: { kind: artifact, path: "x" } }
      : { branches: ["main"] },
  });
  const appDialog = (targetedKeys: string[]) => (
    <TargetFormDialog
      open
      onOpenChange={() => {}}
      environment={{ id: ENV, appId: APP }}
      servers={[{ id: SERVER, name: ".56.129" }]}
      targetedKeys={targetedKeys}
    />
  );

  it.each([
    ["Jar for a jar component", "jar", f.kindJar],
    ["Static web for a static component", "static", f.kindStatic],
  ])("preselects %s", async (_label, artifact, kindLabel) => {
    api.apps = [
      {
        id: APP,
        components: [component("core"), component("core-web", artifact)],
      },
    ];
    await render(appDialog(["core"]));
    expect(checkedKind()).toBe(kindLabel);
    expect(hasLabel(f.services)).toBe(false);
  });

  it("keeps Compose for a container component", async () => {
    api.apps = [
      {
        id: APP,
        components: [component("core"), component("core-web", "jar")],
      },
    ];
    await render(appDialog(["core-web"]));
    expect(checkedKind()).toBe(f.kindCompose);
  });
});

describe("target form kinds", () => {
  it("choosing Jar hides the compose fields and shows the jar fields", async () => {
    await render(dialog());
    expect(hasLabel(f.services)).toBe(true);
    expect(hasLabel(f.tagVariable)).toBe(true);
    expect(hasLabel(f.preStartCommand)).toBe(true);
    expect(hasLabel(f.jarName)).toBe(false);

    await pickKind(f.kindJar);
    expect(hasLabel(f.services)).toBe(false);
    expect(hasLabel(f.tagVariable)).toBe(false);
    expect(hasLabel(f.preStartCommand)).toBe(false);
    expect(hasLabel(f.jarDeployDir)).toBe(true);
    expect(hasLabel(f.jarName)).toBe(true);
    expect(hasLabel(f.systemdUnit)).toBe(true);
    expect(hasLabel(f.healthUrl)).toBe(true);
    expect(hasLabel(f.healthTimeoutSeconds)).toBe(true);
  });

  it("Static web shows the web root and the health timeout only", async () => {
    await render(dialog());
    await pickKind(f.kindStatic);
    expect(hasLabel(f.webRoot)).toBe(true);
    expect(hasLabel(f.healthTimeoutSeconds)).toBe(true);
    expect(hasLabel(f.services)).toBe(false);
    expect(hasLabel(f.jarName)).toBe(false);
    expect(hasLabel(f.healthUrl)).toBe(false);
  });

  it("a jar submit sends kind, jarName and systemdUnit, and no compose fields", async () => {
    api.createDeployTarget.mockResolvedValue({ pipelineFileFailures: [] });
    await render(dialog());
    await pickKind(f.kindJar);
    await type("componentKey", "core-web");
    await type("sourceBranch", "sucor/development");
    await type("deployDir", "/opt/core-web");
    await type("jarName", "core-web-service.jar");
    await type("systemdUnit", "core-web");
    const form = document.querySelector("form");
    await act(async () => {
      form?.requestSubmit();
    });
    await settle();
    expect(api.createDeployTarget).toHaveBeenCalledTimes(1);
    const body = api.createDeployTarget.mock.calls[0]?.[0];
    expect(body).toMatchObject({
      kind: "jar",
      jarName: "core-web-service.jar",
      systemdUnit: "core-web",
      deployDir: "/opt/core-web",
      environmentId: ENV,
    });
    expect(body).not.toHaveProperty("services");
    expect(body).not.toHaveProperty("tagVariable");
    expect(body).not.toHaveProperty("preStartCommand");
  });

  it("shows a pipeline-file failure notice after saving", async () => {
    api.createDeployTarget.mockResolvedValue({
      pipelineFileFailures: [{ branch: "main", componentKey: "core-web" }],
    });
    await render(dialog());
    await pickKind(f.kindStatic);
    await type("componentKey", "core-web");
    await type("sourceBranch", "main");
    await type("deployDir", "/var/www/core-web");
    await act(async () => {
      document.querySelector("form")?.requestSubmit();
    });
    await settle();
    expect(api.createDeployTarget.mock.calls[0]?.[0]).toMatchObject({
      kind: "static",
    });
    expect(api.toast.warning).toHaveBeenCalledWith(
      messages.newEnvironment.pipelineFileNotCommitted
        .replace("{branch}", "main")
        .replace("{component}", "core-web")
    );
  });
});

function SettingsHarness({ kind }: { kind: "jar" | "compose" }) {
  const form = useForm({
    defaultValues: {
      backendServerId: SERVER,
      frontendServerId: "",
      dbServerId: "",
      hasFrontend: false,
      hasDatabase: false,
      dbKind: "",
      targets: [
        {
          id: "t1",
          componentKey: "core-web",
          repoFullName: "dss/core-web",
          kind,
          serverId: SERVER,
          sourceBranch: "main",
          deployDir: "/opt/core-web",
          services: "backend",
          tagVariable: "IMAGE_TAG",
          preStartCommand: "",
          jarName: "core-web-service.jar",
          systemdUnit: "core-web",
          healthUrl: "",
          healthTimeoutSeconds: "180",
          autoDeploy: false,
          backupBeforeDeploy: false,
        },
      ],
    },
  });
  return (
    <Form {...(form as unknown as FormProps)}>
      <SourceDeployTab
        environment={{ id: ENV, appId: null, services: [] } as never}
        servers={[{ id: SERVER, name: ".56.129" }]}
        canManageServers
        deployed={false}
        onSave={async () => {}}
      />
    </Form>
  );
}

describe("editing a target", () => {
  it("shows the kind as text, not a control, and the jar fields", async () => {
    await render(<SettingsHarness kind="jar" />);
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((b) => b.textContent === messages.setup.advancedOptions)
        ?.click();
    });
    await settle();
    expect(document.querySelector('[role="radio"]')).toBeNull();
    expect(container.textContent).toContain(`${f.kind}${f.kindJar}`);
    expect(field("targets.0.jarName")?.value).toBe("core-web-service.jar");
    expect(field("targets.0.systemdUnit")?.value).toBe("core-web");
    expect(field("targets.0.services")).toBeNull();
    expect(field("targets.0.tagVariable")).toBeNull();
  });
});

describe("target summary", () => {
  const base = {
    id: "t1",
    componentKey: "core-web",
    appKey: "core",
    sourceBranch: "main",
    serverId: SERVER,
    deployDir: "/var/www/core-web",
    services: [],
    autoDeploy: false,
    deployNextBuild: false,
    currentTag: null,
    currentStatus: null,
    previousTag: null,
    recentBuilds: [],
    recentDeployments: [],
  };
  const show = (target: Record<string, unknown>) =>
    render(
      <DeploysClient
        environment={
          {
            id: ENV,
            ownerId: null,
            services: [{ server: { id: SERVER, name: ".56.129" } }],
          } as never
        }
        targets={[{ ...base, ...target } as never]}
        settingsHref="/s"
        addTargetHref="/a"
      />
    );

  it("static renders the web root", async () => {
    api.getActiveBuild.mockResolvedValue(null);
    await show({ kind: "static" });
    const line = container.querySelector("[data-slot='card-description']");
    expect(line?.textContent).toBe("main · .56.129 · /var/www/core-web");
  });

  it("jar renders the jar path and the unit", async () => {
    api.getActiveBuild.mockResolvedValue(null);
    await show({
      kind: "jar",
      deployDir: "/opt/core-web",
      jarName: "core-web-service.jar",
      systemdUnit: "core-web",
    });
    const line = container.querySelector("[data-slot='card-description']");
    expect(line?.textContent).toBe(
      "main · .56.129 · /opt/core-web/core-web-service.jar · core-web"
    );
  });
});
