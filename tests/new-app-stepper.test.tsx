// @vitest-environment happy-dom
import {
  keepPreviousData,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/web/api/client";
import messages from "../messages/en.json";

const PROJECT = "0197f3a0-1b2c-7def-8000-0123456789f1";
const APP = "0197f3a0-1b2c-7def-8000-0123456789a1";
const SERVER = "0197f3a0-1b2c-7def-8000-0123456789c1";
const CONN = "0197f3a0-1b2c-7def-8000-0123456789e1";

const calls = vi.hoisted(() => ({
  order: [] as string[],
  register: vi.fn(),
  preview: vi.fn(),
  create: vi.fn(),
  build: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: calls.toast }));
vi.mock("@/hooks/use-unsaved-changes", () => ({
  useUnsavedChanges: () => {},
}));
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: calls.push }),
  Link: ({
    href,
    state,
    children,
    ...rest
  }: {
    href: string;
    state?: unknown;
    children?: React.ReactNode;
  }) => (
    <a href={href} data-state={JSON.stringify(state ?? null)} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/web/api/database-hosts", () => ({
  listDatabaseHostsQuery: () => ({
    queryKey: ["hosts"],
    queryFn: async () => [],
  }),
}));
vi.mock("@/web/api/apps", () => ({
  listConnectionReposQuery: (id: string | null) => ({
    queryKey: ["repos", id],
    queryFn: async () => [
      {
        fullName: "dss/hris",
        forgeRemoteId: "{r1}",
        ciRepoId: "",
        active: false,
        linkedComponentKey: null,
      },
    ],
    enabled: id !== null,
  }),
  pipelinePreviewQuery: () => ({
    queryKey: ["pipeline-preview"],
    queryFn: async () => ({ yaml: "" }),
    enabled: false,
  }),
  registerApp: calls.register,
  triggerComponentBuild: calls.build,
}));
vi.mock("@/web/api/setup", () => ({
  detectRepoQuery: (
    connectionId: string | null,
    repo: string | null,
    branch: string | null
  ) => ({
    queryKey: ["detect", connectionId, repo, branch],
    queryFn: async () => ({
      composeFile: "compose.yaml",
      services: [
        { name: "api", image: null, build: ".", ports: [], profiles: [] },
        {
          name: "web",
          image: null,
          build: "web",
          ports: [{ host: "8080", container: 3000 }],
          profiles: [],
        },
      ],
      dockerfiles: ["Dockerfile", "web/Dockerfile"],
      entryService: "web",
      entryContainerPort: 3000,
      issues: [],
    }),
    enabled: connectionId !== null && repo !== null && branch !== null,
  }),
  setupOptionsQuery: (projectId: string) => ({
    queryKey: ["options", projectId],
    queryFn: async () => ({
      servers: [{ id: SERVER, name: "app-server", host: ".113" }],
      zones: [],
      tunnels: [],
    }),
  }),
  setupAccessPoliciesQuery: (projectId: string) => ({
    queryKey: ["policies", projectId],
    queryFn: async () => [],
  }),
  setupPreviewQuery: (input: unknown) => ({
    queryKey: ["preview", input],
    queryFn: async () => ({
      issues: [],
      plan: [],
      creates: ["Environment Production in HRIS"],
      suggestedEntryPort: null,
      suggestedServices: [],
      slug: "production",
    }),
    enabled: input !== null,
    placeholderData: keepPreviousData,
  }),
  previewEnvironmentSetup: calls.preview,
  createEnvironmentSetup: calls.create,
}));

import { NewAppStepper } from "../web/routes/$locale/_app/-components/setup/new-app-stepper";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
  }
}

async function mount(canGenerate = false) {
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
          <NewAppStepper
            connections={[
              { id: CONN, name: "Woodpecker", hasForgeToken: true },
            ]}
            projects={[{ id: PROJECT, key: "HRIS", name: "HRIS" }]}
            canGenerate={canGenerate}
            canPublish={false}
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
const click = async (el: HTMLElement | undefined) => {
  await act(async () => el?.click());
  await settle();
};
const next = () => click(byText("button", "Next"));

async function pickRepo() {
  await click(byText("button", "dss/hris"));
}

async function fillEnvironment() {
  await act(async () =>
    type(document.querySelector("#env-name") as HTMLInputElement, "Production")
  );
  await click(
    document.querySelector<HTMLElement>('[aria-label="Server"]') ?? undefined
  );
  await click(byText('[role="option"]', "app-server"));
}

/** Walks the stepper to the Review with a valid environment. */
async function toReview() {
  await pickRepo();
  await next();
  await fillEnvironment();
  for (let i = 0; i < 4; i++) await next();
}

const created = {
  environmentId: "env-1",
  projectKey: "HRIS",
  envSlug: "production",
  runId: "run-1",
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  calls.order.length = 0;
  calls.register.mockImplementation(async () => {
    calls.order.push("register");
    return { id: APP, appKey: "hris", name: "hris", components: [] };
  });
  calls.preview.mockImplementation(async () => {
    calls.order.push("preview");
    return {
      issues: [],
      plan: [],
      creates: [],
      suggestedEntryPort: null,
      suggestedServices: [
        { role: "backend", serviceName: "hris-production-api-1" },
      ],
      slug: "production",
    };
  });
  calls.create.mockImplementation(async () => {
    calls.order.push("create");
    return created;
  });
  calls.build.mockImplementation(async () => {
    calls.order.push("build");
    return { number: 1 };
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("New app stepper", () => {
  it("does not leave a step whose inputs are invalid", async () => {
    await mount();
    await next();
    // Still on the repo step, with its error.
    expect(byText("button", "dss/hris")).toBeDefined();
    expect(container.textContent).toContain("Repository");
    expect(document.querySelector("#env-name")).toBeNull();

    await pickRepo();
    await next();
    expect(document.querySelector("#env-name")).not.toBeNull();

    // Environment: no name and no server yet.
    await next();
    expect(document.querySelector("#env-name")).not.toBeNull();
    expect(document.querySelector('[aria-invalid="true"]')).not.toBeNull();
    expect(byText("h3", "Database")).toBeUndefined();

    await fillEnvironment();
    await next();
    expect(document.querySelector("#env-name")).toBeNull();
  });

  it("prefills the services and the entry from the detection", async () => {
    await mount();
    await pickRepo();
    await next();
    expect(
      (document.querySelector("#target-0-services") as HTMLInputElement).value
    ).toBe("api, web");
    await fillEnvironment();
    for (let i = 0; i < 3; i++) await next();
    // Domain step.
    expect(container.textContent).toContain(
      "Detected entry: web listens on container port 3000."
    );
  });

  it("registers, checks, creates and builds in order", async () => {
    await mount();
    await toReview();
    expect(container.textContent).toContain("Register app hris");
    expect(container.textContent).toContain("Start the first build of main");

    await click(byText("button", "Create & deploy"));
    expect(calls.order).toEqual(["register", "preview", "create", "build"]);
    expect(calls.register.mock.calls[0]?.[0]).toMatchObject({
      appKey: "hris",
      components: [
        { componentKey: "hris", ciConnectionId: CONN, pipelineMode: "custom" },
      ],
    });
    expect(calls.create.mock.calls[0]?.[0]).toMatchObject({
      appId: APP,
      projectId: PROJECT,
      name: "Production",
      server: { serverId: SERVER },
      entryService: "web",
      services: [{ role: "backend", serviceName: "hris-production-api-1" }],
      targets: [
        {
          componentKey: "hris",
          sourceBranch: "main",
          services: ["api", "web"],
        },
      ],
    });
    expect(calls.build).toHaveBeenCalledWith("hris", "hris", "main");
    expect(calls.push).toHaveBeenCalledWith("/HRIS/production/deploys");
  });

  it("stops at the setup check when it reports issues", async () => {
    calls.preview.mockResolvedValue({
      issues: [{ field: "name", code: "environmentNameTaken" }],
      plan: [],
      creates: [],
      suggestedEntryPort: null,
      suggestedServices: [],
      slug: "production",
    });
    await mount();
    await toReview();
    await click(byText("button", "Create & deploy"));
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.build).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "The project already has an environment with this name."
    );
  });

  it("says the app exists and links to Add environment when the setup fails (Review Focus 5)", async () => {
    calls.create.mockRejectedValueOnce(new ApiError(409, "Server is full"));
    await mount();
    await toReview();
    await click(byText("button", "Create & deploy"));

    expect(calls.order).toEqual(["register", "preview"]);
    expect(calls.build).not.toHaveBeenCalled();
    expect(calls.push).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Server is full");
    expect(container.textContent).toContain("App hris is registered");

    const link = byText("a", "Add environment") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe(
      "/apps/hris/environments/new?project=HRIS"
    );
    const state = JSON.parse(link.dataset.state ?? "null");
    expect(state.setupEntryService).toBe("web");
    expect(state.setupDraft).toMatchObject({
      projectId: PROJECT,
      name: "Production",
      serverId: SERVER,
      targets: [{ componentKey: "hris", services: "api, web" }],
    });

    // Create again: the app is not registered a second time.
    await click(byText("button", "Create & deploy"));
    expect(calls.register).toHaveBeenCalledOnce();
    expect(calls.order).toEqual([
      "register",
      "preview",
      "preview",
      "create",
      "build",
    ]);
    expect(calls.push).toHaveBeenCalledWith("/HRIS/production/deploys");
  });

  it("does not run the next lines when registration fails", async () => {
    calls.register.mockRejectedValueOnce(
      new ApiError(409, "App hris already exists")
    );
    await mount();
    await toReview();
    await click(byText("button", "Create & deploy"));
    expect(calls.order).toEqual([]);
    expect(container.textContent).toContain("App hris already exists");
    expect(byText("a", "Add environment")).toBeUndefined();
  });

  it("localises a coded refusal by its code, else shows the server's message", async () => {
    calls.create.mockRejectedValueOnce(
      new ApiError(409, "Server text", "environmentSlugTaken")
    );
    await mount();
    await toReview();
    await click(byText("button", "Create & deploy"));
    expect(container.textContent).toContain(
      messages.setupWizard.issues.environmentSlugTaken
    );
    expect(container.textContent).not.toContain("Server text");

    // A code the setup messages lack: the server's message.
    calls.build.mockRejectedValueOnce(
      new ApiError(
        409,
        "This component has no Woodpecker repository",
        "componentNotActivated"
      )
    );
    await click(byText("button", "Create & deploy"));
    expect(container.textContent).toContain(
      "This component has no Woodpecker repository"
    );
  });

  it("keeps the created environment when only the build fails", async () => {
    calls.build.mockRejectedValueOnce(new ApiError(502, "Woodpecker is down"));
    await mount();
    await toReview();
    await click(byText("button", "Create & deploy"));
    expect(container.textContent).toContain("Woodpecker is down");
    expect(calls.push).not.toHaveBeenCalled();
    await click(byText("button", "Create & deploy"));
    // Only the build runs again.
    expect(calls.create).toHaveBeenCalledOnce();
    expect(calls.build).toHaveBeenCalledTimes(2);
    expect(calls.push).toHaveBeenCalledWith("/HRIS/production/deploys");
  });

  it("builds the branch of the deploy target, not the Repo-step branch", async () => {
    await mount();
    await pickRepo();
    await next();
    await act(async () =>
      type(
        document.querySelector("#target-0-branch") as HTMLInputElement,
        "release"
      )
    );
    await fillEnvironment();
    for (let i = 0; i < 4; i++) await next();
    expect(container.textContent).toContain("Start the first build of release");
    expect(container.textContent).not.toContain("first build of main");
    await click(byText("button", "Create & deploy"));
    expect(calls.build).toHaveBeenCalledWith("hris", "hris", "release");
  });

  it("makes the target follow a changed Repo branch unless it was edited", async () => {
    await mount();
    await pickRepo();
    await next();
    const targetBranch = () =>
      (document.querySelector("#target-0-branch") as HTMLInputElement).value;
    expect(targetBranch()).toBe("main");
    // Back to Repo, change the branch, forward again.
    await click(byText("button", "Back"));
    await act(async () =>
      type(
        byText("label", "Branch")
          ?.closest("div")
          ?.querySelector("input") as HTMLInputElement,
        "dev"
      )
    );
    await next();
    expect(targetBranch()).toBe("dev");
    // A hand-edited target branch is kept.
    await act(async () =>
      type(document.querySelector("#target-0-branch") as HTMLInputElement, "qa")
    );
    await click(byText("button", "Back"));
    await act(async () =>
      type(
        byText("label", "Branch")
          ?.closest("div")
          ?.querySelector("input") as HTMLInputElement,
        "dev2"
      )
    );
    await next();
    expect(targetBranch()).toBe("qa");
  });

  it("builds the target branch edited after a setup failure", async () => {
    calls.create.mockRejectedValueOnce(new ApiError(409, "Server is full"));
    await mount();
    await toReview();
    await click(byText("button", "Create & deploy"));
    await click(byText("button", "Back"));
    for (let i = 0; i < 3; i++) await click(byText("button", "Back"));
    await act(async () =>
      type(
        document.querySelector("#target-0-branch") as HTMLInputElement,
        "hotfix"
      )
    );
    for (let i = 0; i < 5; i++) await next();
    expect(container.textContent).toContain("first build of hotfix");
    await click(byText("button", "Create & deploy"));
    expect(calls.build).toHaveBeenCalledWith("hris", "hris", "hotfix");
  });

  it("locks every step but Review once the environment exists", async () => {
    calls.build.mockRejectedValueOnce(new ApiError(502, "Woodpecker is down"));
    await mount();
    await toReview();
    await click(byText("button", "Create & deploy"));
    expect(byText("button", "Back")).toBeUndefined();
    const steps = [
      ...document.querySelectorAll<HTMLButtonElement>("nav button"),
    ];
    expect(steps.length).toBe(6);
    expect(steps.every((b) => b.disabled)).toBe(true);
    // Review still works: Create reruns only the build.
    await click(byText("button", "Create & deploy"));
    expect(calls.create).toHaveBeenCalledOnce();
  });

  it("never offers the generated pipeline mode to a maintainer", async () => {
    await mount(false);
    await pickRepo();
    await act(async () => byText("button", "Custom")?.click());
    const options = [...document.querySelectorAll('[role="option"]')].map(
      (o) => o.textContent
    );
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o?.includes("Generated"))).toBe(false);
  });

  it("offers the generated pipeline mode to an admin", async () => {
    await mount(true);
    await pickRepo();
    await act(async () => byText("button", "Custom")?.click());
    const options = [...document.querySelectorAll('[role="option"]')].map(
      (o) => o.textContent
    );
    expect(options.some((o) => o?.includes("Generated"))).toBe(true);
  });
});
