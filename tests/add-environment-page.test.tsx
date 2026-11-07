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
import { emptyDraft } from "@/lib/setup/draft";
import messages from "../messages/en.json";

const PROJECT = "0197f3a0-1b2c-7def-8000-0123456789f1";
const APP = "0197f3a0-1b2c-7def-8000-0123456789a1";
const SERVER = "0197f3a0-1b2c-7def-8000-0123456789c1";
const HOST = "0197f3a0-1b2c-7def-8000-0123456789d1";
const ZONE = "0197f3a0-1b2c-7def-8000-0123456789b1";
const SOURCE = "0197f3a0-1b2c-7def-8000-0123456789e1";
const SECRET = "TOP-SECRET-VALUE-0123";

const api = vi.hoisted(() => ({
  preview: vi.fn(),
  create: vi.fn(),
  copySource: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: api.toast }));
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ push: api.push }) }));
vi.mock("@/web/api/database-hosts", () => ({
  listDatabaseHostsQuery: () => ({
    queryKey: ["hosts"],
    queryFn: async () => [
      {
        id: HOST,
        serverId: SERVER,
        label: "Main",
        containerName: "pg",
        network: null,
      },
    ],
  }),
}));
vi.mock("@/web/api/setup", () => ({
  setupOptionsQuery: (projectId: string) => ({
    queryKey: ["options", projectId],
    queryFn: async () => ({
      servers: [{ id: SERVER, name: "app-server", host: ".113" }],
      zones: [{ id: ZONE, name: "example.test" }],
      tunnels: [],
    }),
  }),
  setupAccessPoliciesQuery: (projectId: string) => ({
    queryKey: ["policies", projectId],
    queryFn: async () => [{ id: "pol-staff", name: "Staff" }],
  }),
  copySourceQuery: (id: string) => ({
    queryKey: ["copy", id],
    queryFn: () => api.copySource(id),
  }),
  setupPreviewQuery: (input: unknown) => ({
    queryKey: ["preview", input],
    queryFn: () => api.preview(input),
    enabled: input !== null,
    placeholderData: keepPreviousData,
  }),
  createEnvironmentSetup: api.create,
}));

import {
  AddEnvironmentForm,
  type AddEnvironmentProject,
} from "../web/routes/$locale/_app/-components/setup/add-environment-form";

const projects: AddEnvironmentProject[] = [
  {
    id: PROJECT,
    key: "HRIS",
    name: "HRIS",
    environments: [
      { id: SOURCE, name: "Production", appId: APP },
      { id: "other", name: "Unrelated", appId: "another-app" },
    ],
  },
];
// A project where the caller is only a viewer: not for a new environment,
// but its environments of the app can still be copied.
const sourceProjects: AddEnvironmentProject[] = [
  ...projects,
  {
    id: "viewer-project",
    key: "VIEW",
    name: "Viewer project",
    environments: [{ id: "viewer-env", name: "Prod", appId: APP }],
  },
];
const app = {
  id: APP,
  components: [{ componentKey: "hris", buildSpec: { branches: ["main"] } }],
};

// What GET copy-source answers: no secret value, ever.
const copySource = {
  environment: { id: SOURCE, name: "Production", projectId: PROJECT },
  serverId: SERVER,
  targets: [
    {
      componentKey: "hris",
      sourceBranch: "release/1.x",
      autoDeploy: true,
      deployDir: "/deployments/hris-prod",
      services: ["api", "web"],
      tagVariable: "IMAGE_TAG",
      preStartCommand: null,
      healthUrl: null,
      healthTimeoutSeconds: 240,
      backupBeforeDeploy: true,
    },
  ],
  database: { kind: "shared", databaseHostId: HOST },
  domain: { kind: "tunnel", zoneId: ZONE, accessPolicyId: "pol-staff" },
  variables: [
    {
      name: "APP_NAME",
      kind: "plain",
      escrow: false,
      hasValue: true,
      copyable: true,
      value: "Hris",
    },
    {
      name: "SMTP_PASSWORD",
      kind: "secret",
      escrow: false,
      hasValue: true,
      copyable: true,
      // Not sent by the API; here to prove the page would not show it.
      value: SECRET,
    },
    {
      name: "DATA_KEY",
      kind: "secret",
      escrow: true,
      hasValue: true,
      copyable: false,
    },
    {
      name: "SESSION_SECRET",
      kind: "generated",
      escrow: false,
      hasValue: true,
      copyable: false,
    },
  ],
};

const cleanPreview = {
  issues: [],
  plan: [],
  creates: ["Environment Staging in HRIS"],
  suggestedEntryPort: 8104,
  suggestedServices: [
    { role: "backend", serviceName: "hris-staging-api-1" },
    { role: "frontend", serviceName: "hris-staging-web-1" },
  ],
  slug: "staging",
};

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function settle() {
  // Debounce (500 ms), the preview, and the second pass the suggestions cause.
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
  }
}

async function mount(
  canPublish = false,
  initialDraft?: React.ComponentProps<typeof AddEnvironmentForm>["initialDraft"]
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
          <AddEnvironmentForm
            app={app}
            projects={projects}
            canPublish={canPublish}
            sourceProjects={sourceProjects}
            initialDraft={initialDraft}
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
  byText("button", "Create & deploy") as HTMLButtonElement;

async function chooseCopySource() {
  const trigger = document.querySelector<HTMLElement>("#env-copy");
  await act(async () => trigger?.click());
  const option = byText('[role="option"]', "HRIS / Production");
  await act(async () => option?.click());
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  api.preview.mockResolvedValue(cleanPreview);
  api.copySource.mockResolvedValue(copySource);
  api.create.mockResolvedValue({
    environmentId: "env-1",
    projectKey: "HRIS",
    envSlug: "staging",
    runId: "run-1",
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Add environment", () => {
  it("offers only the app's environments as a copy source", async () => {
    await mount();
    await act(async () =>
      document.querySelector<HTMLElement>("#env-copy")?.click()
    );
    const options = [...document.querySelectorAll('[role="option"]')].map(
      (o) => o.textContent
    );
    expect(options).toEqual([
      "Start empty",
      "HRIS / Production",
      "Viewer project / Prod",
    ]);
  });

  it("starts from a draft handed over by another page", async () => {
    const handed = {
      ...emptyDraft(PROJECT, [{ componentKey: "hris" }]),
      name: "Handed over",
      serverId: SERVER,
    };
    await mount(false, handed);
    expect(
      (document.querySelector("#env-name") as HTMLInputElement).value
    ).toBe("Handed over");
    expect(container.textContent).toContain("app-server");
  });

  it("offers only projects the caller maintains for the new environment", async () => {
    await mount();
    await act(async () =>
      document.querySelector<HTMLElement>("#env-project")?.click()
    );
    expect(
      [...document.querySelectorAll('[role="option"]')].map(
        (o) => o.textContent
      )
    ).toEqual(["HRIS"]);
  });

  it("fills the sections from the copy source", async () => {
    await mount();
    await act(async () =>
      type(document.querySelector("#env-name") as HTMLInputElement, "Staging")
    );
    await chooseCopySource();
    expect(api.copySource).toHaveBeenCalledWith(SOURCE);
    const text = container.textContent ?? "";
    expect(text).toContain("app-server");
    expect(text).toContain("Shared database hris_staging");
    expect(text).toContain("hris ← release/1.x");
    // The three copied variables plus the shared database's password.
    expect(text).toContain("5 variables, 2 generated");
    expect(text).toContain("staging.example.test");
  });

  it("shows a secret as 'will be copied' with no value in the page", async () => {
    await mount();
    await chooseCopySource();
    await act(async () => byText("button", "Variables")?.click());
    const text = container.textContent ?? "";
    expect(text).toContain("SMTP_PASSWORD");
    expect(text).toContain("Will be copied");
    expect(text).toContain("A new value will be generated");
    // The escrowed key is never copied: a required input.
    const dataKey = byText("li", "DATA_KEY");
    expect(dataKey?.querySelector("input")?.value).toBe("");
    expect(dataKey?.textContent).not.toContain("Will be copied");
    // Not in the text, the attributes or any input.
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(
      [...document.querySelectorAll("input")].some((i) =>
        i.value.includes(SECRET)
      )
    ).toBe(false);
    // The plain value is shown, editable.
    expect(
      byText("li", "APP_NAME")?.querySelector<HTMLInputElement>("input")?.value
    ).toBe("Hris");
  });

  it("posts the input built from the sections", async () => {
    await mount();
    await chooseCopySource();
    await act(async () => byText("button", "Variables")?.click());
    const dataKey = byText("li", "DATA_KEY")?.querySelector("input");
    await act(async () => type(dataKey as HTMLInputElement, "a-new-key"));
    await act(async () =>
      type(document.querySelector("#env-name") as HTMLInputElement, "Staging")
    );
    await settle();

    expect(createButton().disabled).toBe(false);
    await act(async () => createButton().click());

    expect(api.create).toHaveBeenCalledOnce();
    expect(api.create.mock.calls[0]?.[0]).toMatchObject({
      projectId: PROJECT,
      appId: APP,
      name: "Staging",
      copyFromEnvironmentId: SOURCE,
      server: { serverId: SERVER },
      targets: [
        {
          componentKey: "hris",
          sourceBranch: "release/1.x",
          autoDeploy: true,
          deployDir: "/deployments/hris-staging",
          services: ["api", "web"],
          healthTimeoutSeconds: 240,
          backupBeforeDeploy: true,
        },
      ],
      services: cleanPreview.suggestedServices,
      database: {
        kind: "shared",
        databaseHostId: HOST,
        dbName: "hris_staging",
        dbRole: "hris_staging",
        passwordVariable: "DB_PASSWORD",
      },
      variables: [
        { name: "APP_NAME", kind: "plain", value: "Hris" },
        { name: "SMTP_PASSWORD", kind: "secret", copy: true },
        { name: "DATA_KEY", kind: "secret", value: "a-new-key" },
        { name: "SESSION_SECRET", kind: "generated" },
        { name: "DB_PASSWORD", kind: "generated" },
      ],
      domain: {
        kind: "tunnel",
        zoneId: ZONE,
        label: "staging",
        accessPolicyId: "pol-staff",
        entryPort: 8104,
      },
    });
    expect(api.push).toHaveBeenCalledWith("/HRIS/staging/deploys");
    expect(api.toast.warning).not.toHaveBeenCalled();
  });

  it("previews 500 ms after the last change, not on every key", async () => {
    await mount();
    await chooseCopySource();
    const name = document.querySelector("#env-name") as HTMLInputElement;
    await act(async () => type(name, "S"));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    await act(async () => type(name, "St"));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(api.preview.mock.calls.some(([i]) => i.name === "St")).toBe(false);
    await settle();
    expect(api.preview.mock.calls.some(([i]) => i.name === "St")).toBe(true);
    expect(api.preview.mock.calls.some(([i]) => i.name === "S")).toBe(false);
  });

  it("says provisioning can be started from Deploys when it did not start", async () => {
    api.create.mockResolvedValue({
      environmentId: "env-1",
      projectKey: "HRIS",
      envSlug: "staging",
      runId: null,
      provisioningError: "provisioningStartFailed",
    });
    await mount();
    await chooseCopySource();
    await act(async () => byText("button", "Variables")?.click());
    await act(async () =>
      type(document.querySelector("#env-name") as HTMLInputElement, "Staging")
    );
    await act(async () =>
      type(
        byText("li", "DATA_KEY")?.querySelector("input") as HTMLInputElement,
        "k"
      )
    );
    await settle();
    await act(async () => createButton().click());
    expect(api.toast.warning).toHaveBeenCalledWith(
      messages.setupWizard.addEnvironment.provisioningNotStarted
    );
    expect(api.push).toHaveBeenCalledWith("/HRIS/staging/deploys");
  });

  it("toasts a failed create by its code when known, else by its message", async () => {
    const { ApiError } = await import("@/web/api/client");
    api.create
      .mockRejectedValueOnce(
        new ApiError(409, "Server text", "environmentNameTaken")
      )
      .mockRejectedValueOnce(new ApiError(500, "Internal Server Error"));
    await mount();
    await chooseCopySource();
    await act(async () => byText("button", "Variables")?.click());
    await act(async () =>
      type(document.querySelector("#env-name") as HTMLInputElement, "Staging")
    );
    await act(async () =>
      type(
        byText("li", "DATA_KEY")?.querySelector("input") as HTMLInputElement,
        "k"
      )
    );
    await settle();
    await act(async () => createButton().click());
    await settle();
    expect(api.toast.error).toHaveBeenLastCalledWith(
      messages.setupWizard.issues.environmentNameTaken
    );
    await act(async () => createButton().click());
    await settle();
    expect(api.toast.error).toHaveBeenLastCalledWith("Internal Server Error");
    expect(api.push).not.toHaveBeenCalled();
  });

  it("keeps Create off and says so when the preview request fails", async () => {
    await mount();
    await chooseCopySource();
    await act(async () =>
      type(document.querySelector("#env-name") as HTMLInputElement, "Staging")
    );
    api.preview.mockRejectedValue(new Error("boom"));
    await act(async () =>
      type(document.querySelector("#env-name") as HTMLInputElement, "Staging 2")
    );
    await settle();
    expect(container.textContent).toContain("Could not check the setup");
    const button = createButton();
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(api.create).not.toHaveBeenCalled();
    // Retry runs the preview again; a good answer enables Create.
    api.preview.mockResolvedValue(cleanPreview);
    await act(async () => byText("button", "Try again")?.click());
    await settle();
    expect(container.textContent).not.toContain("Could not check the setup");
  });

  it("never posts a create while the preview reports an issue", async () => {
    api.preview.mockResolvedValue({
      ...cleanPreview,
      issues: [{ field: "name", code: "environmentNameTaken" }],
    });
    await mount();
    await chooseCopySource();
    await act(async () =>
      type(document.querySelector("#env-name") as HTMLInputElement, "Staging")
    );
    await settle();
    expect(container.textContent).toContain(
      "The project already has an environment with this name."
    );
    const button = createButton();
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(api.create).not.toHaveBeenCalled();
  });
});
