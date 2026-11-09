// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const PROJECT = "0197f3a0-1b2c-7def-8000-0123456789f1";
const ENV = "0197f3a0-1b2c-7def-8000-0123456789e1";
const SERVER = "0197f3a0-1b2c-7def-8000-0123456789c1";
const OTHER_SERVER = "0197f3a0-1b2c-7def-8000-0123456789c2";
const HOST = "0197f3a0-1b2c-7def-8000-0123456789d2";
const ZONE = "0197f3a0-1b2c-7def-8000-0123456789b1";
const TARGET = "0197f3a0-1b2c-7def-8000-0123456789a9";
const APP = "0197f3a0-1b2c-7def-8000-0123456789f9";

const api = vi.hoisted(() => ({
  updateEnvironment: vi.fn(),
  updateDeployTarget: vi.fn(),
  createDeployTarget: vi.fn(),
  orgRole: "admin" as string,
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/hooks/use-unsaved-changes", () => ({ useUnsavedChanges: () => {} }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  Link: ({ href, children }: { href: string; children?: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/web/api/session", () => ({
  useMe: () => ({ orgRole: api.orgRole }),
}));
vi.mock("@/web/api/environments", () => ({
  updateEnvironment: api.updateEnvironment,
}));
vi.mock("@/web/api/deploys", () => ({
  updateDeployTarget: api.updateDeployTarget,
  createDeployTarget: api.createDeployTarget,
}));
vi.mock("@/web/api/apps", () => ({
  listAppsQuery: () => ({
    queryKey: ["apps", "listApps"],
    queryFn: async () => [
      {
        id: APP,
        appKey: "kmem",
        components: [
          { componentKey: "kmem-api", repoFullName: "dss/kmem-api" },
          { componentKey: "kmem-web", repoFullName: "dss/kmem-web" },
        ],
      },
    ],
  }),
}));
vi.mock("@/web/api/variables", () => ({
  setEnvFileManaged: vi.fn(),
  listVariablesQuery: (id: string) => ({
    queryKey: ["variables", id],
    queryFn: async () => ({ variables: [] }),
  }),
}));
vi.mock("@/web/api/database-hosts", () => ({
  listDatabaseHostsQuery: () => ({
    queryKey: ["hosts"],
    queryFn: async () => [{ id: HOST, label: "pg", containerName: "pg" }],
  }),
}));
vi.mock("@/web/api/users", () => ({
  listAssignableUsersQuery: (projectId: string) => ({
    queryKey: ["owners", projectId],
    queryFn: async () => [],
  }),
}));
vi.mock("@/web/api/environment-domains", () => ({
  domainAccessPoliciesQuery: (id: string) => ({
    queryKey: ["policies", id],
    queryFn: async () => [],
  }),
  putEnvironmentDomain: vi.fn(),
  deleteEnvironmentDomain: vi.fn(),
}));
vi.mock("@/web/api/mailpit-settings", () => ({
  saveMailpitSettings: vi.fn(),
  testMailpitConnection: vi.fn(),
}));
vi.mock(
  "../web/routes/$locale/_app/-components/env/delete-environment-card",
  () => ({ DeleteEnvironmentCard: () => <p>delete-card</p> })
);

import { ProjectRoleProvider } from "@/components/project-role";
import {
  environmentPayload,
  settingsValues,
} from "../web/routes/$locale/_app/-components/env/settings/settings-form";
import {
  EnvironmentSettingsTabs,
  settingsSearch,
} from "../web/routes/$locale/_app/-components/env/settings/settings-tabs";

type Props = React.ComponentProps<typeof EnvironmentSettingsTabs>;
const ENGINEER = "engineer" as const;

const server = (id: string, name: string) => ({
  id,
  name,
  host: "10.0.0.1",
  port: 22,
});

const environment = {
  id: ENV,
  projectId: PROJECT,
  name: "Dev 1",
  slug: "dev-1",
  kind: "dev",
  ownerId: null,
  owner: null,
  url: null,
  appId: null,
  envFileManaged: false,
  entryPort: null,
  services: [
    {
      id: "svc-backend",
      environmentId: ENV,
      role: "backend",
      serverId: SERVER,
      server: server(SERVER, ".56.129"),
      serviceType: "docker",
      serviceName: "dev1-api-1",
      dbType: null,
      dbName: null,
      dbUser: null,
      dbBackupPath: null,
      dbKind: null,
      databaseHostId: null,
      dbRole: null,
      dbPasswordVariable: null,
      mockTimeApiUrl: null,
      hasDbPassword: false,
      hasMockTimeApiKey: false,
    },
    {
      id: "svc-db",
      environmentId: ENV,
      role: "db",
      serverId: SERVER,
      server: server(SERVER, ".56.129"),
      serviceType: "docker",
      serviceName: "pg",
      dbType: "postgres",
      dbName: "kmem_dev1",
      dbUser: null,
      dbBackupPath: "/var/backups/db",
      dbKind: "shared",
      databaseHostId: HOST,
      dbRole: "kmem_dev1",
      dbPasswordVariable: "DB_PASSWORD",
      mockTimeApiUrl: null,
      hasDbPassword: false,
      hasMockTimeApiKey: false,
    },
  ],
} as unknown as Props["environment"];

const withFrontend = {
  ...environment,
  services: [
    ...environment.services,
    {
      ...environment.services[0],
      id: "svc-frontend",
      role: "frontend",
      serviceName: "dev1-web-1",
    },
  ],
} as Props["environment"];

// Backend, frontend and an own-container database, all on SERVER.
const containerEnv = {
  ...withFrontend,
  services: withFrontend.services.map((svc) =>
    svc.role === "db"
      ? {
          ...svc,
          dbKind: "container",
          databaseHostId: null,
          dbRole: null,
          dbPasswordVariable: null,
        }
      : svc
  ),
} as Props["environment"];

const target = (deployed: boolean) =>
  ({
    id: TARGET,
    environmentId: ENV,
    componentKey: "kmem-api",
    repoFullName: "dss/kmem-api",
    serverId: SERVER,
    sourceBranch: "develop",
    autoDeploy: true,
    deployDir: "/deployments/kmem-dev-1",
    services: ["api"],
    tagVariable: "IMAGE_TAG",
    preStartCommand: null,
    healthUrl: null,
    healthTimeoutSeconds: 180,
    backupBeforeDeploy: false,
    deployNextBuild: false,
    recentBuilds: [],
    recentDeployments: deployed ? [{ id: "dep-1", status: "success" }] : [],
  }) as unknown as Props["targets"][number];

const noDomain = {
  domain: null,
  zones: [{ id: ZONE, name: "example.net" }],
  entryPort: null,
} as unknown as Props["domain"];

const tunnelDomain = {
  domain: {
    kind: "tunnel",
    hostname: "kmem-dev-1.example.net",
    zoneId: ZONE,
    label: "kmem-dev-1",
    accessPolicyId: "pol",
    provisioned: false,
    tunnelName: null,
  },
  zones: [{ id: ZONE, name: "example.net" }],
  entryPort: 8104,
} as unknown as Props["domain"];

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function settle() {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let queryClient: QueryClient;

function defaults(props: Partial<Props>): Props {
  return {
    environment,
    targets: [target(false)],
    domain: noDomain,
    mailpit: null,
    servers: [
      { id: SERVER, name: ".56.129" },
      { id: OTHER_SERVER, name: ".56.115" },
    ],
    projects: [],
    projectKey: "KMEM",
    canManageServers: true,
    canDuplicate: true,
    ...props,
  };
}

// Renders (or re-renders, keeping the form's state) the tabs.
async function render(props: Partial<Props> = {}) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages}>
          <ProjectRoleProvider role={ENGINEER}>
            <EnvironmentSettingsTabs {...defaults(props)} />
          </ProjectRoleProvider>
        </IntlProvider>
      </QueryClientProvider>
    );
  });
  await settle();
}

async function mount(props: Partial<Props> = {}) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await render(props);
}

const t = messages.environmentSettings;
const byText = (selector: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].find(
    (el) => el.textContent?.trim() === text
  );

async function click(el: HTMLElement | null | undefined) {
  if (!el) throw new Error("element not found");
  await act(async () => el.click());
  await settle();
}

const openTab = (label: string) => click(byText('[role="tab"]', label));
const openAdvanced = () =>
  click(byText("button", messages.setup.advancedOptions));
const serverSelects = () =>
  document.querySelectorAll<HTMLElement>("[data-server-select]");

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  api.orgRole = "admin";
  api.updateEnvironment.mockResolvedValue({
    success: true,
    data: { id: ENV },
  });
  api.updateDeployTarget.mockResolvedValue({});
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("environment settings tabs", () => {
  it("renders six tabs", async () => {
    await mount();
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((el) =>
      el.textContent?.trim()
    );
    expect(tabs).toEqual([
      t.tabGeneral,
      t.tabSourceDeploy,
      t.tabDatabase,
      t.tabDomain,
      t.tabMailMockTime,
      t.tabDanger,
    ]);
  });

  it("URL is read-only with a domain", async () => {
    await mount({ domain: tunnelDomain });
    const url = document.querySelector<HTMLInputElement>("#env-url");
    expect(url?.disabled).toBe(true);
  });

  it("URL is editable under Advanced options without a domain", async () => {
    await mount();
    expect(document.querySelector("#env-url")).toBeNull();
    await openAdvanced();
    const url = document.querySelector<HTMLInputElement>("#env-url");
    expect(url).not.toBeNull();
    expect(url?.disabled).toBe(false);
  });

  it("one server picker", async () => {
    await mount();
    await openTab(t.tabSourceDeploy);
    expect(serverSelects()).toHaveLength(1);
    expect(serverSelects()[0]?.id).toBe("env-server");
    await openAdvanced();
    const ids = [...serverSelects()].map((el) => el.id);
    expect(ids).toContain("env-server");
    expect(ids).toContain("server-backend");
    expect(ids.length).toBeGreaterThan(1);
  });

  it("server locked after first deploy", async () => {
    api.orgRole = "member";
    await mount({ targets: [target(true)], canManageServers: false });
    await openTab(t.tabSourceDeploy);
    const select = document.querySelector<HTMLElement>("#env-server");
    expect(
      select?.hasAttribute("data-disabled") ||
        select?.getAttribute("aria-disabled") === "true" ||
        (select as HTMLButtonElement | null)?.disabled
    ).toBe(true);
    expect(document.body.textContent).toContain(t.serverLocked);
  });

  it("server stays open for engineers before the first deploy", async () => {
    api.orgRole = "member";
    await mount({ targets: [target(false)], canManageServers: false });
    await openTab(t.tabSourceDeploy);
    const select = document.querySelector<HTMLElement>("#env-server");
    expect(select?.hasAttribute("data-disabled")).toBe(false);
    expect(document.body.textContent).not.toContain(t.serverLocked);
  });

  it("saving one tab keeps others", async () => {
    await mount();
    const name = document.querySelector<HTMLInputElement>(
      "#env-name"
    ) as HTMLInputElement;
    await act(async () => type(name, "Dev One"));
    await click(byText("button", messages.environmentForm.saveChanges));
    expect(api.updateEnvironment).toHaveBeenCalledTimes(1);
    const [id, payload] = api.updateEnvironment.mock.calls[0] ?? [];
    expect(id).toBe(ENV);
    expect(payload).toMatchObject({
      name: "Dev One",
      hasDatabase: true,
      dbKind: "shared",
      dbName: "kmem_dev1",
      databaseHostId: HOST,
      dbRole: "kmem_dev1",
      dbPasswordVariable: "DB_PASSWORD",
      backendServerId: SERVER,
      backendServiceName: "dev1-api-1",
    });
    expect(payload).not.toHaveProperty("dbPassword");
    expect(api.updateDeployTarget).not.toHaveBeenCalled();
  });
  it("Source & Deploy saves the environment, then only the changed target fields", async () => {
    await mount();
    await openTab(t.tabSourceDeploy);
    const branch = document.querySelector<HTMLInputElement>(
      'input[name="targets.0.sourceBranch"]'
    ) as HTMLInputElement;
    await act(async () => type(branch, "release"));
    await click(byText("button", messages.environmentForm.saveChanges));
    expect(api.updateEnvironment).toHaveBeenCalledTimes(1);
    expect(api.updateDeployTarget).toHaveBeenCalledWith(TARGET, {
      sourceBranch: "release",
    });
    expect(api.updateEnvironment.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      api.updateDeployTarget.mock.invocationCallOrder[0] ?? 0
    );
  });

  it("an invalid advanced field opens Advanced options on save", async () => {
    await mount();
    await openAdvanced();
    const url = document.querySelector<HTMLInputElement>(
      "#env-url"
    ) as HTMLInputElement;
    await act(async () => type(url, "not a url"));
    await openAdvanced();
    expect(document.querySelector("#env-url")).toBeNull();
    await click(byText("button", messages.environmentForm.saveChanges));
    expect(api.updateEnvironment).not.toHaveBeenCalled();
    expect(document.querySelector("#env-url")).not.toBeNull();
    expect(document.body.textContent).toContain(
      messages.environmentForm.urlInvalid
    );
  });
  it("without server:manage a save sends the info fields only", async () => {
    api.orgRole = "member";
    await mount({ canManageServers: false });
    const name = document.querySelector<HTMLInputElement>(
      "#env-name"
    ) as HTMLInputElement;
    await act(async () => type(name, "Dev One"));
    await click(byText("button", messages.environmentForm.saveChanges));
    const [, payload] = api.updateEnvironment.mock.calls[0] ?? [];
    expect(payload).toEqual({
      projectId: PROJECT,
      name: "Dev One",
      kind: "dev",
      ownerId: null,
      url: null,
    });
  });
  it("an admin keeps the server picker after the first deploy", async () => {
    await mount({ targets: [target(true)] });
    await openTab(t.tabSourceDeploy);
    const select = document.querySelector<HTMLElement>("#env-server");
    expect(select?.hasAttribute("data-disabled")).toBe(false);
    expect(document.body.textContent).not.toContain(t.serverLocked);
  });

  it("the one server picker moves every service and target", async () => {
    await mount({ environment: containerEnv });
    await openTab(t.tabSourceDeploy);
    await click(document.querySelector<HTMLElement>("#env-server"));
    await click(byText('[role="option"]', ".56.115"));
    await click(byText("button", messages.environmentForm.saveChanges));
    const [, payload] = api.updateEnvironment.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      backendServerId: OTHER_SERVER,
      frontendServerId: OTHER_SERVER,
      dbServerId: OTHER_SERVER,
      dbKind: "container",
    });
    expect(api.updateDeployTarget).toHaveBeenCalledWith(TARGET, {
      serverId: OTHER_SERVER,
    });
  });

  it("the Database tab saves its fields", async () => {
    await mount();
    await openTab(t.tabDatabase);
    const dbName = document.querySelector<HTMLInputElement>(
      'input[name="dbName"]'
    ) as HTMLInputElement;
    expect(dbName.value).toBe("kmem_dev1");
    await act(async () => type(dbName, "kmem_dev1b"));
    await click(byText("button", messages.environmentForm.saveChanges));
    const [, payload] = api.updateEnvironment.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      name: "Dev 1",
      hasDatabase: true,
      dbKind: "shared",
      dbName: "kmem_dev1b",
      databaseHostId: HOST,
    });
  });

  it("the Mail & Mock time tab saves the mock-time API", async () => {
    await mount();
    await openTab(t.tabMailMockTime);
    const url = document.querySelector<HTMLInputElement>(
      'input[name="backendMockTimeApiUrl"]'
    ) as HTMLInputElement;
    await act(async () => type(url, "https://api.example.com/clock"));
    const saves = [...document.querySelectorAll<HTMLElement>("button")].filter(
      (b) => b.textContent?.trim() === messages.environmentForm.saveChanges
    );
    await click(saves.at(-1));
    const [, payload] = api.updateEnvironment.mock.calls[0] ?? [];
    expect(payload).toMatchObject({
      backendMockTimeApiUrl: "https://api.example.com/clock",
      dbName: "kmem_dev1",
    });
    expect(payload).not.toHaveProperty("backendMockTimeApiKey");
  });

  it("a domain without a stored URL shows the derived address", async () => {
    await mount({ domain: tunnelDomain });
    const url = document.querySelector<HTMLInputElement>("#env-url");
    expect(url?.value).toBe("https://kmem-dev-1.example.net");
    expect(url?.disabled).toBe(true);
  });

  it("with a domain a save leaves the URL to the server", async () => {
    await mount({ domain: tunnelDomain });
    await click(byText("button", messages.environmentForm.saveChanges));
    const [, payload] = api.updateEnvironment.mock.calls[0] ?? [];
    expect(payload).not.toHaveProperty("url");
  });

  it("removing the domain keeps the URL and unlocks the field", async () => {
    const bound = {
      ...environment,
      url: "https://kmem-dev-1.example.net",
    } as Props["environment"];
    await mount({ environment: bound, domain: tunnelDomain });
    await render({ environment: bound, domain: noDomain });
    await openAdvanced();
    const url = document.querySelector<HTMLInputElement>("#env-url");
    expect(url?.disabled).toBe(false);
    expect(url?.value).toBe("https://kmem-dev-1.example.net");
  });

  it("an added target joins the form without dropping unsaved edits", async () => {
    await mount();
    const name = document.querySelector<HTMLInputElement>(
      "#env-name"
    ) as HTMLInputElement;
    await act(async () => type(name, "Dev One"));
    const added = {
      ...target(false),
      id: "0197f3a0-1b2c-7def-8000-0123456789aa",
      componentKey: "kmem-web",
      repoFullName: "dss/kmem-web",
    } as Props["targets"][number];
    await render({ targets: [target(false), added] });
    expect(document.querySelector<HTMLInputElement>("#env-name")?.value).toBe(
      "Dev One"
    );
    await openTab(t.tabSourceDeploy);
    expect(document.body.textContent).toContain("dss/kmem-web");
    expect(document.body.textContent).toContain("dss/kmem-api");
    await click(byText("button", messages.environmentForm.saveChanges));
    expect(api.updateDeployTarget).not.toHaveBeenCalled();
  });

  it("Advanced options reopen on every failed save", async () => {
    await mount();
    await openAdvanced();
    const url = document.querySelector<HTMLInputElement>(
      "#env-url"
    ) as HTMLInputElement;
    await act(async () => type(url, "not a url"));
    const save = () =>
      click(byText("button", messages.environmentForm.saveChanges));
    await save();
    expect(document.querySelector("#env-url")).not.toBeNull();
    await openAdvanced();
    expect(document.querySelector("#env-url")).toBeNull();
    await save();
    expect(document.querySelector("#env-url")).not.toBeNull();
    expect(api.updateEnvironment).not.toHaveBeenCalled();
  });
  it("an engineer before the first deploy moves the app, its container database and targets", async () => {
    api.orgRole = "member";
    await mount({ environment: containerEnv, canManageServers: false });
    await openTab(t.tabSourceDeploy);
    await click(document.querySelector<HTMLElement>("#env-server"));
    await click(byText('[role="option"]', ".56.115"));
    await click(byText("button", messages.environmentForm.saveChanges));
    const [, payload] = api.updateEnvironment.mock.calls[0] ?? [];
    expect(payload).toEqual({
      projectId: PROJECT,
      name: "Dev 1",
      kind: "dev",
      ownerId: null,
      url: null,
      backendServerId: OTHER_SERVER,
      frontendServerId: OTHER_SERVER,
      dbServerId: OTHER_SERVER,
    });
    expect(api.updateDeployTarget).toHaveBeenCalledWith(TARGET, {
      serverId: OTHER_SERVER,
    });
  });

  it("moving away from a shared database's host is blocked and keeps dbServerId", async () => {
    await mount({ environment: withFrontend });
    await openTab(t.tabSourceDeploy);
    await click(document.querySelector<HTMLElement>("#env-server"));
    await click(byText('[role="option"]', ".56.115"));
    expect(document.body.textContent).toContain(t.serverSharedDbElsewhere);
    const save = byText(
      "button",
      messages.environmentForm.saveChanges
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await click(save);
    expect(api.updateEnvironment).not.toHaveBeenCalled();
  });

  it("an engineer is not offered a server away from the shared database's host", async () => {
    api.orgRole = "member";
    await mount({ environment: withFrontend, canManageServers: false });
    await openTab(t.tabSourceDeploy);
    await click(document.querySelector<HTMLElement>("#env-server"));
    const options = [...document.querySelectorAll('[role="option"]')].map(
      (el) => el.textContent?.trim()
    );
    expect(options).toEqual([".56.129"]);
  });
});

describe("adding a deploy target from Source & Deploy", () => {
  const tDeploys = messages.deploys;
  const addButtons = () =>
    [...document.querySelectorAll<HTMLElement>("button")].filter(
      (b) => b.textContent?.trim() === tDeploys.addTarget
    );
  const dialog = () => document.querySelector('[role="dialog"]');
  const withApp = { ...environment, appId: APP } as Props["environment"];

  it("offers Add target under the empty state, without opening Advanced options", async () => {
    await mount({ targets: [] });
    await openTab(t.tabSourceDeploy);
    expect(document.body.textContent).toContain(t.noTargets);
    expect(addButtons()).toHaveLength(1);
    await openAdvanced();
    expect(addButtons()).toHaveLength(1);
  });

  it("offers Add target under the targets list, without opening Advanced options", async () => {
    await mount();
    await openTab(t.tabSourceDeploy);
    expect(addButtons()).toHaveLength(1);
    await openAdvanced();
    expect(addButtons()).toHaveLength(1);
  });

  it("opens the add-target dialog when asked to (?add=target)", async () => {
    const onAddingTargetChange = vi.fn();
    await mount({
      targets: [],
      tab: "source",
      addingTarget: true,
      onAddingTargetChange,
    });
    expect(dialog()?.textContent).toContain(tDeploys.form.createTitle);
    await click(
      [...(dialog()?.querySelectorAll<HTMLElement>("button") ?? [])].find(
        (b) => b.textContent?.trim() === messages.common.cancel
      )
    );
    expect(onAddingTargetChange).toHaveBeenLastCalledWith(false);
  });

  it("asks for the component as free text when the environment has no app", async () => {
    await mount({ targets: [] });
    await openTab(t.tabSourceDeploy);
    await click(addButtons()[0]);
    expect(
      dialog()?.querySelector('input[name="componentKey"]')
    ).not.toBeNull();
  });

  it("picks the component from the environment's app and preselects the one not yet targeted", async () => {
    await mount({ environment: withApp });
    await openTab(t.tabSourceDeploy);
    await click(addButtons()[0]);
    expect(dialog()?.querySelector('input[name="componentKey"]')).toBeNull();
    const trigger = dialog()?.querySelector<HTMLElement>("#target-component");
    expect(trigger?.textContent).toContain("kmem-web");
    expect(trigger?.textContent).toContain("dss/kmem-web");
    await click(trigger);
    const options = [...document.querySelectorAll('[role="option"]')].map(
      (el) => el.textContent
    );
    expect(options).toHaveLength(2);
    expect(options[0]).toContain("kmem-api");
    expect(options[0]).toContain("dss/kmem-api");
  });

  it("preselects nothing when more than one component is free", async () => {
    await mount({ environment: withApp, targets: [] });
    await openTab(t.tabSourceDeploy);
    await click(addButtons()[0]);
    const trigger = dialog()?.querySelector<HTMLElement>("#target-component");
    expect(trigger?.textContent).toContain(tDeploys.form.componentPlaceholder);
  });
});

describe("settingsSearch", () => {
  it("keeps a known tab and the add-target request", () => {
    expect(settingsSearch({ tab: "source", add: "target" })).toEqual({
      tab: "source",
      add: "target",
    });
    expect(settingsSearch({ tab: "nope", add: "nope" })).toEqual({});
  });
});

describe("environmentPayload", () => {
  it("sends an engineer's changed server ids only, never other bindings", () => {
    const saved = settingsValues(environment, [target(false)]);
    const moved = { ...saved, backendServerId: OTHER_SERVER };
    expect(
      environmentPayload(moved, saved, {
        canManageServers: false,
        hasDomain: false,
      })
    ).toEqual({
      projectId: PROJECT,
      name: "Dev 1",
      kind: "dev",
      ownerId: null,
      url: null,
      backendServerId: OTHER_SERVER,
    });
  });
});
