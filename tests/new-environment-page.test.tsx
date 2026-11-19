// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isNotFound } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const PROJECT = "0197f3a0-1b2c-7def-8000-0123456789f1";
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
  checkSlug: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/i18n/navigation", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRouter: () => ({ push: api.push }),
}));
vi.mock("@/web/api/service-catalog", async (importOriginal) => ({
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
    queryFn: async () => [{ id: "pol-acme", name: "Internal staff" }],
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
vi.mock("@/web/api/environments", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkEnvironmentSlugQuery: (
    projectId: string,
    slug: string,
    environmentId?: string
  ) => ({
    queryKey: ["check-slug", projectId, slug, environmentId],
    queryFn: () => api.checkSlug(projectId, slug, environmentId),
  }),
}));
vi.mock("@/web/api/project-sources", () => ({
  listProjectSourcesQuery: (projectId: string) => ({
    queryKey: ["project-sources", projectId],
    queryFn: async () => [],
  }),
}));

import { SETUP_PERMISSIONS } from "@/lib/permissions";
import {
  NewEnvironmentForm,
  type NewEnvironmentProject,
  type NewEnvironmentService,
} from "../web/routes/$locale/_app/-components/setup/new-environment-form";
import { Route } from "../web/routes/$locale/_app/$projectKey.environments.new";

const services: NewEnvironmentService[] = [
  {
    componentKey: "kmem-api",
    ciConnectionId: CONN,
    repoFullName: "acme/kmem-api",
    buildSpec: null,
  },
  {
    componentKey: "kmem-web",
    ciConnectionId: CONN,
    repoFullName: "acme/kmem-web",
    buildSpec: null,
  },
  // A service of another former app.
  {
    componentKey: "hris",
    ciConnectionId: CONN,
    repoFullName: "acme/hris",
    buildSpec: null,
  },
];

const emptyProject: NewEnvironmentProject = {
  id: PROJECT,
  key: "KMEM",
  defaultServerId: SERVER,
  environments: [],
};
// OLD_ENV deploys kmem-api only.
const projectWithEnvs: NewEnvironmentProject = {
  ...emptyProject,
  environments: [
    { id: OLD_ENV, name: "Dev 1" },
    { id: NEW_ENV, name: "Dev 2" },
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
  domain: { kind: "tunnel", zoneId: ZONE, accessPolicyId: "pol-acme" },
  variables: [],
});

function plan(issues: { field: string; code: string }[] = []) {
  return {
    registrations: [],
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
        accessPolicyId: "pol-acme",
        entryPort: 8104,
      },
    },
    summary: {
      serverName: ".10.129",
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
            services={services}
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
    servers: [{ id: SERVER, name: ".10.129", host: "192.168.10.129" }],
    zones: [{ id: ZONE, name: "example.net" }],
    tunnels: [],
  });
  api.preview.mockResolvedValue(cleanPreview);
  api.checkSlug.mockResolvedValue({ code: null });
  api.copySource.mockImplementation(async (id: string) => copySource(id));
  api.repos.mockResolvedValue([
    {
      ciConnectionId: CONN,
      repoFullName: "acme/hris",
      componentKey: "hris",
      defaultBranch: "main",
    },
    {
      ciConnectionId: CONN,
      repoFullName: "acme/kmem-api",
      componentKey: "kmem-api",
      defaultBranch: "main",
    },
    {
      ciConnectionId: CONN,
      repoFullName: "acme/kmem-worker",
      componentKey: null,
      defaultBranch: "develop",
    },
    {
      ciConnectionId: CONN,
      repoFullName: "acme/fresh",
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
    pipelineFileFailures: [],
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
      messages.newEnvironment.services,
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

  it("warns with the branch when a pipeline file was not committed", async () => {
    api.create.mockResolvedValueOnce({
      environmentId: "env-3",
      projectKey: "KMEM",
      envSlug: "dev-3",
      runId: "run-1",
      buildFailures: [],
      pipelineFileFailures: [
        {
          componentKey: "hris",
          branch: "dev-3",
          code: null,
          error: "Branch dev-3 does not exist",
        },
      ],
    });
    await mount({ project: projectWithEnvs });
    await act(async () => type(nameInput(), "Dev 3"));
    await pressCreate();
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.toast.warning).toHaveBeenCalledWith(
      "The pipeline file was not committed to dev-3 of hris. An admin can commit it again on the service's page."
    );
    expect(api.push).toHaveBeenCalledWith("/KMEM/dev-3/deploys");
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
      "Server .10.129 · port 8104 · database kmem_dev3 · https://kmem-dev-3.example.net"
    );
    expect(api.create).not.toHaveBeenCalled();
  });

  it("starts from the newest environment, or ?from=", async () => {
    await mount({ project: projectWithEnvs });
    expect(document.querySelector("#env-start-from")?.textContent).toContain(
      "Copy of Dev 2"
    );
    expect(container.textContent).toContain("acme/kmem-api");
    act(() => root.unmount());
    container.remove();
    await mount({ project: projectWithEnvs, initialFrom: OLD_ENV });
    expect(document.querySelector("#env-start-from")?.textContent).toContain(
      "Copy of Dev 1"
    );
  });

  it("takes ?repo='s non-artifact service when the repo builds several, and starts new", async () => {
    // An artifact service of the same repo, listed first.
    const legacy: NewEnvironmentService = {
      componentKey: "kmem-legacy-api",
      ciConnectionId: CONN,
      repoFullName: "acme/kmem-api",
      buildSpec: { branches: [], artifact: { kind: "jar", path: "a.jar" } },
    };
    await mount({
      project: projectWithEnvs,
      services: [legacy, ...services],
      initialRepo: "acme/kmem-api",
    });
    expect(document.querySelector("#env-start-from")?.textContent).toContain(
      "New"
    );
    expect(container.textContent).toContain("kmem-api");
    expect(container.textContent).not.toContain("kmem-legacy-api");
  });

  it("preselects ?repo= of a new repository and starts new", async () => {
    await mount({ initialRepo: "acme/kmem-worker" });
    expect(document.querySelector("#env-start-from")?.textContent).toContain(
      "New"
    );
    expect(container.textContent).toContain("acme/kmem-worker");
  });

  it("warns, without blocking, about a custom repo with no pipeline file", async () => {
    api.preview.mockResolvedValue({
      ...cleanPreview,
      plan: {
        ...plan(),
        warnings: [{ field: "repos.0", code: "pipelineFileMissing" }],
      },
    });
    await mount({ initialRepo: "acme/kmem-worker" });
    await act(async () =>
      byText("button", messages.setup.advancedOptions)?.click()
    );
    await settle();
    expect(container.textContent).toContain(
      messages.newEnvironment.pipelineFileMissing
    );
    expect(alerts()).toHaveLength(0);
  });

  it("offers the repositories of any service, naming the service", async () => {
    await mount({ project: projectWithEnvs });
    await act(async () =>
      document.querySelector<HTMLElement>("#env-repo-picker")?.click()
    );
    await settle();
    const hris = byText('[role="option"]', "acme/hris");
    expect(hris?.textContent).toContain("hris");
    expect(hris?.getAttribute("aria-disabled")).not.toBe("true");
    // The copied repository is listed once.
    expect(
      byText('[role="option"]', "acme/kmem-api")?.getAttribute("aria-disabled")
    ).toBe("true");
    const free = byText('[role="option"]', "acme/kmem-worker");
    expect(free?.getAttribute("aria-disabled")).not.toBe("true");
    // Picking a repository runs the check (detection) with every repo listed.
    await act(async () => free?.click());
    await settle();
    expect(api.preview).toHaveBeenCalledOnce();
    // The copied service by key, the new repository to register.
    expect(api.preview.mock.calls[0]?.[0].services).toEqual([
      { componentKey: "kmem-api", branch: "develop" },
    ]);
    expect(api.preview.mock.calls[0]?.[0].repos).toEqual([
      // The repository's main branch on the forge.
      {
        ciConnectionId: CONN,
        repoFullName: "acme/kmem-worker",
        branch: "develop",
      },
    ]);
  });

  it("picks any subset of the services and sends them by key", async () => {
    await mount();
    await act(async () =>
      document.querySelector<HTMLElement>("#env-service-picker")?.click()
    );
    await settle();
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("hris"),
      expect.stringContaining("kmem-api"),
      expect.stringContaining("kmem-web"),
    ]);
    await act(async () => byText('[role="option"]', "kmem-web")?.click());
    await settle();
    expect(api.preview).toHaveBeenCalledOnce();
    expect(api.preview.mock.calls[0]?.[0]).toMatchObject({
      services: [{ componentKey: "kmem-web", branch: "main" }],
      repos: [],
    });
    // A picked service is not offered again.
    await act(async () =>
      document.querySelector<HTMLElement>("#env-service-picker")?.click()
    );
    await settle();
    expect(byText('[role="option"]', "kmem-web")).toBeUndefined();
  });

  it("starts new with ?service= picked", async () => {
    await mount({ project: projectWithEnvs, initialService: "hris" });
    expect(document.querySelector("#env-start-from")?.textContent).toContain(
      "New"
    );
    expect(container.textContent).toContain("acme/hris");
  });

  it("shows each service's default deploy dir after a check", async () => {
    await mount({ initialService: "kmem-api" });
    await act(async () => type(nameInput(), "Dev 3"));
    await pressCreate();
    expect(container.textContent).toContain(
      messages.newEnvironment.deployDir.replace(
        "{dir}",
        "/deployments/kmem-dev-3"
      )
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
      byText('[role="option"]', "acme/kmem-worker")?.click()
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
              repoFullName: "acme/kmem-worker",
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
      await mount({ initialRepo: "acme/kmem-worker", canChoosePipelines });
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
              repoFullName: "acme/kmem-worker",
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
          repoFullName: "acme/kmem-worker",
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
        { repoFullName: "acme/kmem-worker", mode: "custom" },
      ]);
    });
  });

  it("keeps registered repositories pickable next to a new one", async () => {
    await mount({ initialRepo: "acme/kmem-worker" });
    await act(async () =>
      document.querySelector<HTMLElement>("#env-repo-picker")?.click()
    );
    await settle();
    expect(
      byText('[role="option"]', "acme/kmem-api")?.getAttribute("aria-disabled")
    ).not.toBe("true");
    expect(
      byText('[role="option"]', "acme/fresh")?.getAttribute("aria-disabled")
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
      "Behind the Internal staff access policy."
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
    // Named by the field's label, not its input path.
    const list = byText("li", messages.setupWizard.issues.invalid);
    expect(list?.textContent).toContain(messages.newEnvironment.address);
    expect(list?.textContent).not.toContain("domain.label");
    await act(async () => type(addressInput, "good"));
    await settle();
    expect(api.preview).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      messages.setupWizard.sections.deploy
    );
  });

  describe("sources mode", () => {
    const openPicker = async () => {
      await act(async () =>
        document.querySelector<HTMLElement>("#env-repo-picker")?.click()
      );
      await settle();
    };

    it("a repo picked without a copy starts on the project default", async () => {
      await mount({
        project: emptyProject,
        sources: {
          serviceKeys: ["kmem-api", "kmem-web"],
          defaultBranches: { "kmem-api": "kestrel/development" },
        },
      });
      await openPicker();
      await act(async () =>
        byText('[role="option"]', "acme/kmem-api")?.click()
      );
      await settle();
      expect(api.preview).toHaveBeenCalledOnce();
      expect(api.preview.mock.calls[0]?.[0]).toMatchObject({
        services: [{ componentKey: "kmem-api", branch: "kestrel/development" }],
        repos: [],
      });
    });

    it("a copy keeps its branches; a repo added to it starts on the project default", async () => {
      api.repos.mockResolvedValue([
        {
          ciConnectionId: CONN,
          repoFullName: "acme/kmem-web",
          componentKey: "kmem-web",
          defaultBranch: "main",
        },
      ]);
      // A refusal keeps the page open for the next pick.
      api.preview.mockResolvedValueOnce({
        plan: plan(),
        preview: {
          ...cleanPreview.preview,
          issues: [{ field: "name", code: "environmentNameTaken" }],
        },
      });
      await mount({
        project: projectWithEnvs,
        initialFrom: OLD_ENV,
        sources: {
          serviceKeys: ["kmem-api", "kmem-web"],
          defaultBranches: {
            "kmem-api": "kestrel/development",
            "kmem-web": "kestrel/demo",
          },
        },
      });
      await act(async () => type(nameInput(), "Dev 3"));
      await pressCreate();
      // The copy is faithful: the source's branch, so no repos are sent.
      expect(api.preview.mock.calls[0]?.[0]).toMatchObject({
        copyFromEnvironmentId: OLD_ENV,
        services: [],
        repos: [],
      });
      await openPicker();
      await act(async () =>
        byText('[role="option"]', "acme/kmem-web")?.click()
      );
      await settle();
      expect(api.preview).toHaveBeenCalledTimes(2);
      expect(api.preview.mock.calls[1]?.[0]).toMatchObject({
        services: [
          { componentKey: "kmem-api", branch: "develop" },
          { componentKey: "kmem-web", branch: "kestrel/demo" },
        ],
        repos: [],
      });
    });

    it("offers only the project's services in the service picker", async () => {
      await mount({
        project: emptyProject,
        services: services.filter((x) => x.componentKey !== "hris"),
        sources: { serviceKeys: ["kmem-api", "kmem-web"], defaultBranches: {} },
      });
      await act(async () =>
        document.querySelector<HTMLElement>("#env-service-picker")?.click()
      );
      await settle();
      expect(byText('[role="option"]', "hris")).toBeUndefined();
      expect(byText('[role="option"]', "kmem-web")).toBeDefined();
    });

    it("repositories of services outside the sources are disabled with the Sources hint", async () => {
      await mount({
        project: emptyProject,
        sources: { serviceKeys: ["kmem-api", "kmem-web"], defaultBranches: {} },
      });
      await openPicker();
      const hris = byText('[role="option"]', "acme/hris");
      expect(hris?.getAttribute("aria-disabled")).toBe("true");
      expect(hris?.textContent).toContain("not in this project's sources");
      expect(hris?.textContent).toContain("hris");
      // A project service's and an unregistered repository stay pickable.
      expect(
        byText('[role="option"]', "acme/kmem-api")?.getAttribute(
          "aria-disabled"
        )
      ).not.toBe("true");
      expect(
        byText('[role="option"]', "acme/fresh")?.getAttribute("aria-disabled")
      ).not.toBe("true");
    });
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

describe("the URL name field", () => {
  const slugInput = () =>
    document.querySelector<HTMLInputElement>("#env-slug") as HTMLInputElement;
  const errors = messages.actionErrors;
  // Past the live check's debounce.
  const pause = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });

  it("defaults to the name's URL name and leaves it to the server", async () => {
    await mount({ project: projectWithEnvs });
    await act(async () => type(nameInput(), "Dev 3 (West)"));
    await settle();
    expect(slugInput().value).toBe("");
    expect(slugInput().placeholder).toBe("dev-3-west");
    expect(container.textContent).toContain("/KMEM/");
    await pressCreate();
    expect(api.preview.mock.calls[0]?.[0]).not.toHaveProperty("slug");
    expect(api.create.mock.calls[0]?.[0]).not.toHaveProperty("slug");
    expect(api.checkSlug).not.toHaveBeenCalled();
  });

  it("shows the URL name the server gives once a check ran", async () => {
    // `dev-3` is taken (here, an old URL name): the server gives `dev-3-2`.
    api.preview.mockResolvedValue({
      plan: plan([{ field: "domain.zoneId", code: "required" }]),
      preview: { ...cleanPreview.preview, slug: "dev-3-2" },
    });
    await mount({ project: projectWithEnvs });
    await act(async () => type(nameInput(), "Dev 3"));
    await settle();
    expect(slugInput().placeholder).toBe("dev-3");
    await pressCreate();
    expect(api.create).not.toHaveBeenCalled();
    expect(slugInput().placeholder).toBe("dev-3-2");
    // Another name: the check is out of date, the name's own again.
    await act(async () => type(nameInput(), "Dev 4"));
    await settle();
    expect(slugInput().placeholder).toBe("dev-4");
  });

  it("caps the default at 40 characters", async () => {
    await mount();
    await act(async () => type(nameInput(), "Kestrel ".repeat(8)));
    await settle();
    expect(slugInput().placeholder.length).toBeLessThanOrEqual(40);
    expect(slugInput().placeholder).toMatch(/^kestrel(-kestrel)*$/);
  });

  it("sends an edited URL name once checked free", async () => {
    await mount({ project: projectWithEnvs });
    await act(async () => type(nameInput(), "Dev 3"));
    await act(async () => type(slugInput(), "KMEM-West"));
    expect(slugInput().value).toBe("kmem-west");
    await pause();
    await settle();
    expect(api.checkSlug).toHaveBeenCalledWith(PROJECT, "kmem-west", undefined);
    expect(alerts()).toHaveLength(0);
    await pressCreate();
    expect(api.preview.mock.calls[0]?.[0]).toMatchObject({
      slug: "kmem-west",
    });
    expect(api.create.mock.calls[0]?.[0]).toMatchObject({ slug: "kmem-west" });
  });

  it("shows a URL name the project already uses while typing", async () => {
    api.checkSlug.mockResolvedValue({ code: "environmentSlugTaken" });
    await mount();
    await act(async () => type(nameInput(), "Dev 3"));
    await act(async () => type(slugInput(), "dev-1"));
    await pause();
    await settle();
    expect(container.textContent).toContain(errors.environmentSlugTaken);
    expect(slugInput().getAttribute("aria-invalid")).toBe("true");
  });

  it("refuses a malformed or reserved URL name without asking the server", async () => {
    await mount();
    await act(async () => type(slugInput(), "dev 3"));
    await settle();
    expect(container.textContent).toContain(errors.environmentSlugInvalid);
    await act(async () => type(slugInput(), "settings"));
    await settle();
    expect(container.textContent).toContain(errors.environmentSlugReserved);
    await pause();
    expect(api.checkSlug).not.toHaveBeenCalled();
  });

  it("shows a slug lost between the check and the create at the field", async () => {
    const { ApiError } = await import("@/web/api/client");
    api.create.mockRejectedValueOnce(
      new ApiError(409, "taken", "environmentSlugAliasTaken")
    );
    await mount({ project: projectWithEnvs });
    await act(async () => type(nameInput(), "Dev 3"));
    await act(async () => type(slugInput(), "qa"));
    await pause();
    await pressCreate();
    expect(api.create).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(errors.environmentSlugAliasTaken);
    expect(api.toast.error).not.toHaveBeenCalled();
    expect(api.push).not.toHaveBeenCalled();
  });
});
