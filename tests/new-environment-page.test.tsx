// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isNotFound } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const PROJECT = "0197f3a0-1b2c-7def-8000-0123456789f1";
const APP = "0197f3a0-1b2c-7def-8000-0123456789a1";
const OTHER_APP = "0197f3a0-1b2c-7def-8000-0123456789a2";
const SERVER = "0197f3a0-1b2c-7def-8000-0123456789c1";
const ZONE = "0197f3a0-1b2c-7def-8000-0123456789b1";
const CONN = "0197f3a0-1b2c-7def-8000-0123456789d1";
const HOST = "0197f3a0-1b2c-7def-8000-0123456789d2";
const OLD_ENV = "0197f3a0-1b2c-7def-8000-0123456789e1";
const NEW_ENV = "0197f3a0-1b2c-7def-8000-0123456789e2";

const api = vi.hoisted(() => ({
  preview: vi.fn(),
  create: vi.fn(),
  copySource: vi.fn(),
  repos: vi.fn(),
  options: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: api.push }),
}));
vi.mock("@/web/api/apps", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  pipelinePreviewQuery: (componentKey: string, buildSpec: unknown) => ({
    queryKey: ["pipeline-preview", componentKey, buildSpec],
    queryFn: async () => ({ yaml: "steps: []" }),
    enabled: buildSpec !== null,
  }),
}));
vi.mock("@/web/api/database-hosts", () => ({
  listDatabaseHostsQuery: () => ({
    queryKey: ["hosts"],
    queryFn: async () => [],
  }),
}));
vi.mock("@/web/api/users", () => ({
  listAssignableUsersQuery: (projectId: string) => ({
    queryKey: ["owners", projectId],
    queryFn: async () => [],
  }),
}));
vi.mock("@/web/api/setup", () => ({
  setupOptionsQuery: (projectId: string) => ({
    queryKey: ["options", projectId],
    queryFn: () => api.options(projectId),
  }),
  setupAccessPoliciesQuery: (projectId: string) => ({
    queryKey: ["policies", projectId],
    queryFn: async () => [{ id: "pol-dss", name: "DSS Internal" }],
  }),
  copySourceQuery: (id: string) => ({
    queryKey: ["copy", id],
    queryFn: () => api.copySource(id),
  }),
  setupReposQuery: (q: string) => ({
    queryKey: ["repos", q],
    queryFn: () => api.repos(q),
  }),
  previewNewEnvironment: api.preview,
  createNewEnvironment: api.create,
}));

import { SETUP_PERMISSIONS } from "@/lib/permissions";
import {
  type NewEnvironmentApp,
  NewEnvironmentForm,
  type NewEnvironmentProject,
} from "../web/routes/$locale/_app/-components/setup/new-environment-form";
import { Route } from "../web/routes/$locale/_app/$projectKey.environments.new";

const apps: NewEnvironmentApp[] = [
  {
    id: APP,
    appKey: "kmem",
    name: "KMEM",
    components: [
      {
        componentKey: "kmem-api",
        ciConnectionId: CONN,
        repoFullName: "dss/kmem-api",
        buildSpec: null,
      },
      {
        componentKey: "kmem-web",
        ciConnectionId: CONN,
        repoFullName: "dss/kmem-web",
        buildSpec: null,
      },
    ],
  },
  {
    id: OTHER_APP,
    appKey: "hris",
    name: "HRIS",
    components: [
      {
        componentKey: "hris",
        ciConnectionId: CONN,
        repoFullName: "dss/hris",
        buildSpec: null,
      },
    ],
  },
];

const emptyProject: NewEnvironmentProject = {
  id: PROJECT,
  key: "KMEM",
  defaultServerId: SERVER,
  environments: [],
};
// OLD_ENV was set up before the app gained kmem-web.
const projectWithEnvs: NewEnvironmentProject = {
  ...emptyProject,
  environments: [
    { id: OLD_ENV, name: "Dev 1", appId: APP },
    { id: NEW_ENV, name: "Dev 2", appId: APP },
  ],
};

const copySource = (id: string) => ({
  environment: { id, name: id === OLD_ENV ? "Dev 1" : "Dev 2" },
  serverId: SERVER,
  targets: [
    {
      componentKey: "kmem-api",
      sourceBranch: "develop",
      autoDeploy: true,
      services: ["api"],
      tagVariable: "IMAGE_TAG",
      preStartCommand: null,
      healthUrl: null,
      healthTimeoutSeconds: 180,
      backupBeforeDeploy: false,
    },
  ],
  database: { kind: "shared", databaseHostId: null },
  domain: { kind: "tunnel", zoneId: ZONE, accessPolicyId: "pol-dss" },
  variables: [],
});

function plan(issues: { field: string; code: string }[] = []) {
  return {
    registrations: [],
    appKey: "kmem",
    setup: {
      projectId: PROJECT,
      name: "Dev 3",
      kind: null,
      ownerId: null,
      copyFromEnvironmentId: null,
      server: { serverId: SERVER },
      targets: [
        {
          componentKey: "kmem-api",
          sourceBranch: "develop",
          autoDeploy: true,
          deployDir: "/deployments/kmem-dev-3",
          services: ["api"],
          tagVariable: "IMAGE_TAG",
          preStartCommand: null,
          healthUrl: null,
          healthTimeoutSeconds: 180,
          backupBeforeDeploy: false,
        },
      ],
      services: [{ role: "backend", serviceName: "kmem-dev-3-api-1" }],
      entryService: null,
      database: {
        kind: "shared",
        databaseHostId: HOST,
        dbName: "kmem_dev3",
        dbRole: "kmem_dev3",
        passwordVariable: "DB_PASSWORD",
      },
      variables: [
        { name: "DB_PASSWORD", kind: "generated" },
        { name: "ENTRY_PORT", kind: "plain", value: "8104" },
      ],
      domain: {
        kind: "tunnel",
        zoneId: ZONE,
        label: "kmem-dev-3",
        accessPolicyId: "pol-dss",
        entryPort: 8104,
      },
    },
    summary: {
      serverName: ".56.129",
      port: 8104,
      databaseName: "kmem_dev3",
      url: "https://kmem-dev-3.example.net",
    },
    issues,
    warnings: [],
  };
}

const cleanPreview = {
  plan: plan(),
  preview: {
    issues: [],
    plan: [],
    creates: ["Environment Dev 3 in KMEM"],
    suggestedEntryPort: 8104,
    suggestedServices: [],
    slug: "dev-3",
  },
};

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

async function mount(
  props: Partial<React.ComponentProps<typeof NewEnvironmentForm>> = {}
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <IntlProvider locale="en" messages={messages}>
          <NewEnvironmentForm
            project={emptyProject}
            apps={apps}
            canPublish={false}
            canChoosePipelines={false}
            {...props}
          />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
  await settle();
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const byText = (selector: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((el) =>
    el.textContent?.includes(text)
  );
const createButton = () =>
  byText("button", messages.setupWizard.review.submit) as HTMLButtonElement;
const alerts = () => document.querySelectorAll('[role="alert"]');
const nameInput = () =>
  document.querySelector<HTMLInputElement>("#env-name") as HTMLInputElement;

async function pressCreate() {
  await act(async () => createButton().click());
  await settle();
}

beforeEach(() => {
  api.options.mockResolvedValue({
    servers: [{ id: SERVER, name: ".56.129", host: "192.168.10.129" }],
    zones: [{ id: ZONE, name: "example.net" }],
    tunnels: [],
  });
  api.preview.mockResolvedValue(cleanPreview);
  api.copySource.mockImplementation(async (id: string) => copySource(id));
  api.repos.mockResolvedValue([
    {
      ciConnectionId: CONN,
      repoFullName: "dss/hris",
      appKey: "hris",
      appName: "HRIS",
      componentKey: "hris",
      defaultBranch: "main",
    },
    {
      ciConnectionId: CONN,
      repoFullName: "dss/kmem-api",
      appKey: "kmem",
      appName: "KMEM",
      componentKey: "kmem-api",
      defaultBranch: "main",
    },
    {
      ciConnectionId: CONN,
      repoFullName: "dss/kmem-worker",
      appKey: null,
      appName: null,
      componentKey: null,
      defaultBranch: "develop",
    },
    {
      ciConnectionId: CONN,
      repoFullName: "dss/fresh",
      appKey: null,
      appName: null,
      componentKey: null,
      defaultBranch: "main",
    },
  ]);
  api.create.mockResolvedValue({
    environmentId: "env-3",
    projectKey: "KMEM",
    envSlug: "dev-3",
    runId: "run-1",
    buildFailures: [],
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

describe("New environment page", () => {
  it("shows four fields", async () => {
    await mount();
    const text = container.textContent ?? "";
    for (const label of [
      messages.newEnvironment.startFrom,
      messages.newEnvironment.name,
      messages.newEnvironment.repository,
      messages.newEnvironment.needsDatabase,
      messages.newEnvironment.address,
    ]) {
      expect(text).toContain(label);
    }
    // The project has a default server: no server picker.
    expect(document.querySelector("#env-server")).toBeNull();
    const advanced = byText("button", messages.setup.advancedOptions);
    expect(advanced?.getAttribute("aria-expanded")).toBe("false");
    expect(text).not.toContain(messages.setupWizard.sections.deploy);
    expect(api.preview).not.toHaveBeenCalled();
  });

  it("no errors before interaction", async () => {
    await mount();
    expect(alerts()).toHaveLength(0);
    await act(async () => type(nameInput(), "D"));
    await settle();
    expect(alerts()).toHaveLength(0);
    // Typing never runs the check.
    expect(api.preview).not.toHaveBeenCalled();
  });

  it("errors after Create", async () => {
    await mount();
    await pressCreate();
    expect(byText('[role="alert"]', messages.setupWizard.issues.required)).toBe(
      byText("[data-slot=field-error]", messages.setupWizard.issues.required)
    );
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(api.preview).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it("no red flash after success", async () => {
    await mount({ project: projectWithEnvs });
    await act(async () => type(nameInput(), "Dev 3"));
    await pressCreate();
    expect(api.preview).toHaveBeenCalledOnce();
    // A copy whose repositories are the source's sends none.
    expect(api.preview.mock.calls[0]?.[0]).toMatchObject({
      projectId: PROJECT,
      name: "Dev 3",
      copyFromEnvironmentId: NEW_ENV,
      repos: [],
      needsDatabase: true,
      address: { label: "" },
    });
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.create.mock.calls[0]?.[0]).toEqual(
      api.preview.mock.calls[0]?.[0]
    );
    expect(api.push).toHaveBeenCalledWith("/KMEM/dev-3/deploys");
    await settle();
    expect(api.preview).toHaveBeenCalledOnce();
    expect(alerts()).toHaveLength(0);
    expect(
      (
        byText(
          "button",
          messages.setupWizard.review.creating
        ) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });

  it("shows ask-an-admin when no server", async () => {
    api.preview.mockResolvedValue({
      plan: plan([{ field: "serverId", code: "noServerAvailable" }]),
      preview: null,
    });
    await mount();
    await act(async () => type(nameInput(), "Dev 3"));
    await pressCreate();
    expect(container.textContent).toContain(messages.setup.noServerAvailable);
    expect(createButton().disabled).toBe(true);
    expect(api.create).not.toHaveBeenCalled();
  });

  it("shows the summary above Create after a check", async () => {
    api.preview.mockResolvedValue({
      ...cleanPreview,
      plan: plan([{ field: "domain.zoneId", code: "required" }]),
      preview: null,
    });
    await mount({ project: projectWithEnvs });
    await act(async () => type(nameInput(), "Dev 3"));
    await pressCreate();
    expect(container.textContent).toContain(
      "Server .56.129 · port 8104 · database kmem_dev3 · https://kmem-dev-3.example.net"
    );
    expect(api.create).not.toHaveBeenCalled();
  });

  it("starts from the newest environment, or ?from=", async () => {
    await mount({ project: projectWithEnvs });
    expect(document.querySelector("#env-start-from")?.textContent).toContain(
      "Copy of Dev 2"
    );
    expect(container.textContent).toContain("dss/kmem-api");
    act(() => root.unmount());
    container.remove();
    await mount({ project: projectWithEnvs, initialFrom: OLD_ENV });
    expect(document.querySelector("#env-start-from")?.textContent).toContain(
      "Copy of Dev 1"
    );
  });

  it("preselects ?repo= and starts new when no environment has its app", async () => {
    await mount({ initialRepo: "dss/kmem-worker" });
    expect(document.querySelector("#env-start-from")?.textContent).toContain(
      "New"
    );
    expect(container.textContent).toContain("dss/kmem-worker");
  });

  it("lists other apps' repositories disabled, with their app", async () => {
    await mount({ project: projectWithEnvs });
    await act(async () =>
      document.querySelector<HTMLElement>("#env-repo-picker")?.click()
    );
    await settle();
    const hris = byText('[role="option"]', "dss/hris");
    expect(hris?.textContent).toContain("HRIS");
    expect(hris?.getAttribute("aria-disabled")).toBe("true");
    const free = byText('[role="option"]', "dss/kmem-worker");
    expect(free?.getAttribute("aria-disabled")).not.toBe("true");
    // Picking a repository runs the check (detection) with every repo listed.
    await act(async () => free?.click());
    await settle();
    expect(api.preview).toHaveBeenCalledOnce();
    expect(api.preview.mock.calls[0]?.[0].repos).toEqual([
      { ciConnectionId: CONN, repoFullName: "dss/kmem-api", branch: "develop" },
      // The repository's main branch on the forge.
      {
        ciConnectionId: CONN,
        repoFullName: "dss/kmem-worker",
        branch: "develop",
      },
    ]);
  });

  it("offers the missing repository of an older copy", async () => {
    api.preview.mockResolvedValueOnce({
      plan: plan(),
      preview: {
        ...cleanPreview.preview,
        issues: [{ field: "targets", code: "targetMissing" }],
      },
    });
    await mount({ project: projectWithEnvs, initialFrom: OLD_ENV });
    await act(async () => type(nameInput(), "Dev 3"));
    await pressCreate();
    expect(container.textContent).toContain(
      messages.setupWizard.issues.targetMissing
    );
    expect(api.create).not.toHaveBeenCalled();
    await act(async () => byText("button", "Add dss/kmem-web")?.click());
    await settle();
    expect(api.preview).toHaveBeenCalledTimes(2);
    expect(api.preview.mock.calls[1]?.[0].repos).toEqual([
      { ciConnectionId: CONN, repoFullName: "dss/kmem-api", branch: "develop" },
      { ciConnectionId: CONN, repoFullName: "dss/kmem-web", branch: "main" },
    ]);
    expect(container.textContent).not.toContain(
      messages.setupWizard.issues.targetMissing
    );
  });

  it("checks when Advanced options opens and sends only edited sections", async () => {
    await mount({ project: projectWithEnvs });
    await act(async () => type(nameInput(), "Dev 3"));
    await act(async () =>
      byText("button", messages.setup.advancedOptions)?.click()
    );
    await settle();
    expect(api.preview).toHaveBeenCalledOnce();
    expect(api.preview.mock.calls[0]?.[0].advanced).toBeUndefined();
    // The database section, seeded from the plan; the role follows the name.
    await act(async () =>
      byText("button", messages.setupWizard.sections.database)?.click()
    );
    const dbName = document.querySelector("#db-name") as HTMLInputElement;
    expect(dbName.value).toBe("kmem_dev3");
    await act(async () => type(dbName, "kmem_qa"));
    expect((document.querySelector("#db-role") as HTMLInputElement).value).toBe(
      "kmem_qa"
    );
    await pressCreate();
    expect(api.preview).toHaveBeenCalledTimes(2);
    expect(api.preview.mock.calls[1]?.[0].advanced).toEqual({
      database: {
        kind: "shared",
        databaseHostId: HOST,
        dbName: "kmem_qa",
        passwordVariable: "DB_PASSWORD",
      },
    });
    // The simple checkbox defers to the edited section.
    expect(container.textContent).toContain(
      messages.newEnvironment.setInAdvanced
    );
  });

  it("keeps an Advanced edit made while a check is pending", async () => {
    await mount({ project: projectWithEnvs });
    await act(async () => type(nameInput(), "Dev 3"));
    await act(async () =>
      byText("button", messages.setup.advancedOptions)?.click()
    );
    await settle();
    await act(async () =>
      byText("button", messages.setupWizard.sections.database)?.click()
    );
    // A slow check: picking a repository while the answer is pending.
    let answer: (value: unknown) => void = () => {};
    api.preview.mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve))
    );
    await act(async () =>
      document.querySelector<HTMLElement>("#env-repo-picker")?.click()
    );
    await settle();
    await act(async () =>
      byText('[role="option"]', "dss/kmem-worker")?.click()
    );
    await settle();
    expect(api.preview).toHaveBeenCalledTimes(2);
    const dbName = document.querySelector("#db-name") as HTMLInputElement;
    await act(async () => type(dbName, "kmem_edit"));
    await act(async () => answer(cleanPreview));
    await settle();
    expect((document.querySelector("#db-name") as HTMLInputElement).value).toBe(
      "kmem_edit"
    );
    await pressCreate();
    expect(api.preview.mock.calls.at(-1)?.[0].advanced.database).toMatchObject({
      kind: "shared",
      dbName: "kmem_edit",
    });
  });

  describe("pipelines of new repositories", () => {
    const spec = {
      branches: ["develop"],
      tagShaLength: 7,
      images: [{ name: "kmem-worker", dockerfile: "Dockerfile", context: "." }],
      bundleFiles: [{ from: "compose.yaml", to: "compose.yaml" }],
      checks: [],
      timeoutMinutes: 60,
    };
    beforeEach(() => {
      api.preview.mockResolvedValue({
        ...cleanPreview,
        plan: {
          ...plan(),
          registrations: [
            {
              repoFullName: "dss/kmem-worker",
              ciConnectionId: CONN,
              componentKey: "kmem-worker",
              pipelineMode: "generated",
              buildSpec: spec,
            },
          ],
        },
      });
    });

    async function pickWorkerAndOpen(canChoosePipelines: boolean) {
      await mount({ initialRepo: "dss/kmem-worker", canChoosePipelines });
      await act(async () => type(nameInput(), "Dev 3"));
      await act(async () =>
        byText("button", messages.setup.advancedOptions)?.click()
      );
      await settle();
    }

    it("are not offered to an engineer", async () => {
      await pickWorkerAndOpen(false);
      expect(container.textContent).toContain(
        messages.setupWizard.sections.deploy
      );
      expect(container.textContent).not.toContain(
        messages.newEnvironment.pipelines
      );
    });

    it("an admin chooses the mode and edits the build spec", async () => {
      // An open issue keeps Create from creating, so it can be pressed twice.
      api.preview.mockResolvedValue({
        ...cleanPreview,
        plan: {
          ...plan([{ field: "plan", code: "no_targets" }]),
          registrations: [
            {
              repoFullName: "dss/kmem-worker",
              ciConnectionId: CONN,
              componentKey: "kmem-worker",
              pipelineMode: "generated",
              buildSpec: spec,
            },
          ],
        },
        preview: null,
      });
      await pickWorkerAndOpen(true);
      expect(container.textContent).toContain(
        messages.newEnvironment.pipelines
      );
      // The detected spec, in the reused registration editor.
      const branches = byText(
        "[data-slot=field]",
        messages.appForm.branches
      )?.querySelector("input") as HTMLInputElement;
      expect(branches.value).toBe("develop");
      await act(async () => type(branches, "develop, main"));
      await pressCreate();
      expect(api.preview.mock.calls.at(-1)?.[0].advanced.pipelines).toEqual([
        {
          repoFullName: "dss/kmem-worker",
          mode: "generated",
          buildSpec: { ...spec, branches: ["develop", "main"] },
        },
      ]);
      await act(async () =>
        document.querySelector<HTMLElement>("#pipeline-kmem-worker")?.click()
      );
      await act(async () =>
        byText(
          '[role="option"]',
          messages.newEnvironment.pipelineModeCustom
        )?.click()
      );
      await pressCreate();
      expect(api.preview.mock.calls.at(-1)?.[0].advanced.pipelines).toEqual([
        { repoFullName: "dss/kmem-worker", mode: "custom" },
      ]);
    });
  });

  it("disables registered repositories once a new app's repository is picked", async () => {
    await mount({ initialRepo: "dss/kmem-worker" });
    await act(async () =>
      document.querySelector<HTMLElement>("#env-repo-picker")?.click()
    );
    await settle();
    expect(
      byText('[role="option"]', "dss/kmem-api")?.getAttribute("aria-disabled")
    ).toBe("true");
    expect(
      byText('[role="option"]', "dss/fresh")?.getAttribute("aria-disabled")
    ).not.toBe("true");
  });

  it("says the repositories are loading", async () => {
    api.repos.mockImplementation(() => new Promise(() => {}));
    await mount();
    await act(async () =>
      document.querySelector<HTMLElement>("#env-repo-picker")?.click()
    );
    await settle();
    expect(document.body.textContent).toContain(
      messages.newEnvironment.reposLoading
    );
  });

  it("names the default access policy after a check", async () => {
    await mount({ project: projectWithEnvs });
    expect(container.textContent).toContain(
      messages.newEnvironment.addressHint
    );
    await act(async () => type(nameInput(), "Dev 3"));
    await act(async () =>
      byText("button", messages.setup.advancedOptions)?.click()
    );
    await settle();
    expect(container.textContent).toContain(
      "Behind the DSS Internal access policy."
    );
  });

  it("asks to fix the fields before Advanced options, then checks", async () => {
    await mount({ project: projectWithEnvs });
    const addressInput = document.querySelector(
      "#env-address"
    ) as HTMLInputElement;
    await act(async () => type(addressInput, "-bad-"));
    await act(async () =>
      byText("button", messages.setup.advancedOptions)?.click()
    );
    await settle();
    expect(api.preview).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      messages.newEnvironment.fixFieldsFirst
    );
    await act(async () => type(addressInput, "good"));
    await settle();
    expect(api.preview).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      messages.setupWizard.sections.deploy
    );
  });

  it("qa sees forbidden", async () => {
    const queryClient = {
      query: async ({ queryKey }: { queryKey: unknown[] }) => {
        if (queryKey[1] === "getProjectByKeyWithEnvironments") {
          return { ...emptyProject, name: "KMEM" };
        }
        if (queryKey[1] === "getMyProjectAccess") {
          return { roles: { [PROJECT]: role } };
        }
        throw new Error(`unexpected query ${String(queryKey[1])}`);
      },
    };
    const beforeLoad = Route.options.beforeLoad as unknown as (ctx: {
      params: { projectKey: string };
      context: { queryClient: typeof queryClient };
    }) => Promise<unknown>;
    let role = "qa";
    const run = () =>
      beforeLoad({ params: { projectKey: "KMEM" }, context: { queryClient } });
    const refused = await run().catch((error: unknown) => error);
    expect(isNotFound(refused)).toBe(true);
    role = "viewer";
    expect(isNotFound(await run().catch((error: unknown) => error))).toBe(true);
    role = "engineer";
    await expect(run()).resolves.toEqual({ projectId: PROJECT });
    expect(SETUP_PERMISSIONS.environment).toEqual(["create"]);
  });
});
