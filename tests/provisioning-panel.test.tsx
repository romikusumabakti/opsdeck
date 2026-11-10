// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { IntlProvider } from "use-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectRoleProvider } from "@/components/project-role";
import {
  databaseBindingPayload,
  suggestSharedDbName,
} from "@/lib/environment-database-binding";
import {
  buildEnvironmentPayload,
  type EnvironmentSubmitValues,
} from "@/lib/environment-submit-payload";
import type { ProvisioningStepSpec } from "@/lib/provisioning/plan";
import type { ProvisioningStep } from "@/web/api/provisioning";
import messages from "../messages/en.json";

// The POST is a spy: the tests check it waits for the confirm dialog.
const api = vi.hoisted(() => ({ startProvisioning: vi.fn() }));
vi.mock("@/web/api/provisioning", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/web/api/provisioning")>()),
  startProvisioning: api.startProvisioning,
}));

import {
  type ProvisioningLookups,
  ProvisioningPanel,
  ProvisioningPanelView,
} from "../web/routes/$locale/_app/-components/env/provisioning-panel";

const plan: ProvisioningStepSpec[] = [
  {
    kind: "prepare_deploy_dir",
    params: { serverId: "s1", deployDir: "/deployments/hris" },
  },
  {
    kind: "create_database",
    params: {
      databaseHostId: "h1",
      database: "hris_staging",
      role: "hris_staging",
      passwordVariable: "DB_PASSWORD",
    },
  },
  { kind: "deploy", params: { targetId: "t1", branch: "main" } },
];

const lookups: ProvisioningLookups = {
  serverLabel: (id) => (id === "s1" ? "app-server (.113)" : undefined),
  databaseHost: (id) =>
    id === "h1"
      ? { label: "Main", containerName: "dplk-postgres", serverId: "s1" }
      : undefined,
  componentKey: (id) => (id === "t1" ? "hris" : undefined),
  tunnelName: (id) => (id === "rt-1" ? "dss-srv-113" : undefined),
  policyName: (id) => (id === "pol-1" ? "DSS staff" : undefined),
};

const HOST = "hris-staging.example.net";
const domainPlan: ProvisioningStepSpec[] = [
  {
    kind: "prepare_deploy_dir",
    params: { serverId: "s1", deployDir: "/deployments/hris" },
  },
  {
    kind: "access_app",
    params: {
      zoneId: "z1",
      remoteTunnelId: "rt-1",
      hostname: HOST,
      policyId: "pol-1",
    },
  },
  {
    kind: "tunnel_route",
    params: {
      zoneId: "z1",
      remoteTunnelId: "rt-1",
      hostname: HOST,
      service: "http://localhost:8091",
    },
  },
  {
    kind: "dns_record",
    params: { zoneId: "z1", hostname: HOST, remoteTunnelId: "rt-1" },
  },
  { kind: "deploy", params: { targetId: "t1", branch: "main" } },
];
const domainBlock = {
  hostname: HOST,
  remoteTunnelId: "rt-1",
  tunnelName: "dss-srv-113",
  accessPolicyId: "pol-1",
  policyName: "DSS staff",
};

function step(
  index: number,
  status: ProvisioningStep["status"],
  extra: Partial<ProvisioningStep> = {}
): ProvisioningStep {
  const spec = plan[index] as ProvisioningStepSpec;
  return {
    id: `step-${index}`,
    environmentId: "e1",
    position: index,
    kind: spec.kind,
    params: spec.params,
    status,
    lastError: null,
    lastRunId: null,
    ...extra,
  } as ProvisioningStep;
}

function wrap(node: React.ReactNode, role: "viewer" | "engineer" = "engineer") {
  return (
    <IntlProvider locale="en" messages={messages}>
      <ProjectRoleProvider role={role}>{node}</ProjectRoleProvider>
    </IntlProvider>
  );
}

function view(
  props: Partial<React.ComponentProps<typeof ProvisioningPanelView>>
) {
  return renderToString(
    wrap(
      <ProvisioningPanelView
        plan={plan}
        steps={[]}
        activeRunId={null}
        canRun
        lookups={lookups}
        onProvision={() => {}}
        onViewLog={() => {}}
        {...props}
      />
    )
  );
}

describe("ProvisioningPanelView", () => {
  it("lists the plan as an ordered list of human sentences", () => {
    const html = view({});
    expect(html).toContain("<ol");
    expect(html).toContain("Prepare <code");
    expect(html).toContain("/deployments/hris");
    expect(html).toContain("app-server (.113)");
    expect(html).toContain("Create role and database");
    expect(html).toContain("hris_staging");
    expect(html).toContain("dplk-postgres");
    expect(html).toContain("Deploy the latest");
    expect(html.indexOf("Prepare")).toBeLessThan(
      html.indexOf("Create role and database")
    );
    expect(html.indexOf("Create role and database")).toBeLessThan(
      html.indexOf("Deploy the latest")
    );
    expect(html).toContain(">Provision<");
  });

  it("falls back to ids when a lookup misses", () => {
    const html = view({
      lookups: {
        serverLabel: () => undefined,
        databaseHost: () => undefined,
        componentKey: () => undefined,
        tunnelName: () => undefined,
        policyName: () => undefined,
      },
    });
    expect(html).toContain("s1");
    expect(html).toContain("h1");
    expect(html).toContain("t1");
  });

  it("shows each step's status and the failed step's error, and offers Retry", () => {
    const html = view({
      steps: [
        step(0, "done"),
        step(1, "failed", { lastError: "role already owns objects" }),
      ],
    });
    expect(html).toContain("Done");
    expect(html).toContain("Failed");
    expect(html).toContain("Pending");
    expect(html).toContain("role already owns objects");
    expect(html).toContain(">Retry<");
    expect(html).not.toContain(">Provision<");
  });

  it("disables the button and links the log while a run is active", () => {
    const html = view({
      steps: [step(0, "running")],
      activeRunId: "run-1",
    });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Provisioning…/);
    expect(html).toContain("View log");
  });

  it("shows the error for a refused start", () => {
    expect(view({ errorCode: "missing_db_fields" })).toContain(
      "The shared database is incomplete"
    );
    expect(view({ errorCode: "no_targets" })).toContain(
      "Add a deploy target first"
    );
  });

  it("lists the domain steps with tunnel and policy names, in order", () => {
    const html = view({ plan: domainPlan });
    const text = html.replace(/<[^>]+>/g, "");
    const sentences = [
      "Prepare /deployments/hris",
      `Create Access app for ${HOST} (DSS staff)`,
      `Add tunnel route ${HOST} → http://localhost:8091 on dss-srv-113`,
      `Publish DNS record ${HOST}`,
      "Deploy the latest main build of hris",
    ];
    let at = -1;
    for (const sentence of sentences) {
      const next = text.indexOf(sentence);
      expect(next, sentence).toBeGreaterThan(at);
      at = next;
    }
  });

  it("falls back to the tunnel and policy ids", () => {
    const text = view({
      plan: domainPlan,
      lookups: {
        ...lookups,
        tunnelName: () => undefined,
        policyName: () => undefined,
      },
    }).replace(/<[^>]+>/g, "");
    expect(text).toContain("on rt-1");
    expect(text).toContain(`Create Access app for ${HOST} (pol-1)`);
  });

  it("explains a missing entry port", () => {
    expect(view({ errorCode: "missing_entry_port" })).toContain(
      "The domain needs the local port"
    );
  });

  it("shows only the no-targets hint when there are no targets", () => {
    const html = view({ plan: [], noTargets: true });
    expect(html).toContain("Add a deploy target first");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<ol");
  });

  it("renders nothing without deploy permission", () => {
    expect(view({ canRun: false })).toBe("");
  });
});

describe("ProvisioningPanel", () => {
  const environment = {
    id: "e1",
    services: [
      { server: { id: "s1", name: "app-server", host: "10.0.0.113" } },
    ],
  } as never;
  const targets = [{ id: "t1", componentKey: "hris" }] as never;

  function client(showPanel = true, withDomain = false) {
    // Seeded and never refetched: no network in these tests.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    queryClient.setQueryData(["provisioning", "getProvisioning", "e1"], {
      steps: [],
      plan: withDomain ? domainPlan : plan,
      activeRunId: null,
      showPanel,
      domain: withDomain ? domainBlock : null,
    });
    queryClient.setQueryData(["databaseHosts", "listDatabaseHosts", []], []);
    return queryClient;
  }
  function panel(role: "viewer" | "engineer", showPanel = true) {
    return renderToString(
      <QueryClientProvider client={client(showPanel)}>
        {wrap(
          <ProvisioningPanel environment={environment} targets={targets} />,
          role
        )}
      </QueryClientProvider>
    );
  }

  it("is shown to a maintainer", () => {
    expect(panel("engineer")).toContain(">Provision<");
  });

  it("names the tunnel and policy from the GET's domain block", () => {
    const text = renderToString(
      <QueryClientProvider client={client(true, true)}>
        {wrap(
          <ProvisioningPanel environment={environment} targets={targets} />
        )}
      </QueryClientProvider>
    ).replace(/<[^>]+>/g, "");
    expect(text).toContain(
      `Add tunnel route ${HOST} → http://localhost:8091 on dss-srv-113`
    );
    expect(text).toContain(`Create Access app for ${HOST} (DSS staff)`);
  });

  it("is hidden when the API says so (a legacy env that already deployed)", () => {
    expect(panel("engineer", false)).toBe("");
  });

  it("refreshes the deploy targets when a provisioning run ends (its deploy step queued a deployment)", async () => {
    const queryClient = client();
    queryClient.setQueryData(["provisioning", "getProvisioning", "e1"], {
      steps: [],
      plan,
      activeRunId: "run-1",
      showPanel: true,
      domain: null,
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          {wrap(
            <ProvisioningPanel environment={environment} targets={targets} />
          )}
        </QueryClientProvider>
      )
    );
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["deploys"] });
    await act(async () => {
      queryClient.setQueryData(["provisioning", "getProvisioning", "e1"], {
        steps: [],
        plan,
        activeRunId: null,
        showPanel: true,
        domain: null,
      });
    });
    // React Query notifies observers on a scheduled tick, not inside act().
    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["deploys"] })
    );
    await act(async () => root.unmount());
    container.remove();
  });

  it("re-reads provisioning when a target's current tag changes (a deploy finished)", async () => {
    const queryClient = client();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (currentTag: string | null) =>
      root.render(
        <QueryClientProvider client={queryClient}>
          {wrap(
            <ProvisioningPanel
              environment={environment}
              targets={
                [{ id: "t1", componentKey: "hris", currentTag }] as never
              }
            />
          )}
        </QueryClientProvider>
      );
    await act(async () => render(null));
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["provisioning"] });
    await act(async () => render("main-abc"));
    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["provisioning"] })
    );
    await act(async () => root.unmount());
    container.remove();
  });

  describe("Provision button", () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      api.startProvisioning.mockReset();
    });

    async function mount() {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await act(async () => {
        root.render(
          <QueryClientProvider client={client()}>
            {wrap(
              <ProvisioningPanel environment={environment} targets={targets} />
            )}
          </QueryClientProvider>
        );
      });
    }
    const button = (name: string) =>
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent?.trim() === name
      );
    const dialog = () => document.querySelector('[role="alertdialog"]');

    it("opens a confirm dialog listing the plan before any POST", async () => {
      api.startProvisioning.mockResolvedValue({ runId: "run-1" });
      await mount();
      expect(dialog()).toBeNull();
      await act(async () => button("Provision")?.click());
      expect(api.startProvisioning).not.toHaveBeenCalled();
      const text = dialog()?.textContent ?? "";
      expect(text).toContain("Run provisioning?");
      expect(text).toContain("Prepare /deployments/hris");
      expect(text).toContain("Create role and database hris_staging");
      expect(text).toContain("Deploy the latest main build of hris");

      const confirm = [...(dialog()?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent?.trim() === "Provision"
      );
      await act(async () => confirm?.click());
      expect(api.startProvisioning).toHaveBeenCalledExactlyOnceWith("e1");
    });

    it("sends nothing when the dialog is cancelled", async () => {
      await mount();
      await act(async () => button("Provision")?.click());
      await act(async () => button("Cancel")?.click());
      expect(api.startProvisioning).not.toHaveBeenCalled();
    });
  });

  function noTargetsPanel(data?: object) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false } },
    });
    if (data) {
      queryClient.setQueryData(["provisioning", "getProvisioning", "e1"], {
        steps: [],
        plan: [],
        activeRunId: null,
        showPanel: true,
        domain: null,
        ...data,
      });
    }
    return renderToString(
      <QueryClientProvider client={queryClient}>
        {wrap(<ProvisioningPanel environment={environment} targets={[]} />)}
      </QueryClientProvider>
    );
  }

  it("is hidden with no targets and no provisioning steps (nothing to do)", () => {
    expect(noTargetsPanel({})).toBe("");
    expect(noTargetsPanel({ showPanel: false })).toBe("");
    // Still loading: nothing, rather than a hint that may vanish.
    expect(noTargetsPanel()).toBe("");
  });

  it("keeps the no-targets hint when provisioning has run before", () => {
    const html = noTargetsPanel({ steps: [step(0, "done")] });
    expect(html).toContain("Add a deploy target first");
    expect(html).not.toContain(">Provision<");
  });

  it("keeps the no-targets hint while a run is active", () => {
    const html = noTargetsPanel({ activeRunId: "run-1" });
    expect(html).toContain("Add a deploy target first");
  });

  it("is hidden from a user who cannot run deploys", () => {
    expect(panel("viewer")).toBe("");
  });
});

describe("databaseBindingPayload", () => {
  const base = {
    databaseHostId: "h1",
    dbRole: " hris_staging ",
    dbPasswordVariable: "DB_PASSWORD",
  };

  it("sends the host, role and password variable for a shared database", () => {
    expect(databaseBindingPayload({ ...base, dbKind: "shared" })).toEqual({
      dbKind: "shared",
      databaseHostId: "h1",
      dbRole: "hris_staging",
      dbPasswordVariable: "DB_PASSWORD",
    });
  });

  it("omits the shared fields for the other kinds", () => {
    expect(databaseBindingPayload({ ...base, dbKind: "container" })).toEqual({
      dbKind: "container",
    });
    expect(databaseBindingPayload({ ...base, dbKind: "external" })).toEqual({
      dbKind: "external",
    });
    expect(databaseBindingPayload({ ...base, dbKind: "" })).toEqual({});
  });
});

describe("buildEnvironmentPayload", () => {
  const values: EnvironmentSubmitValues & { projectId: string; name: string } =
    {
      projectId: "p1",
      name: "Staging",
      kind: "",
      ownerId: "",
      url: "",
      hasDatabase: true,
      hasFrontend: false,
      dbServerId: "srv-db",
      dbServiceType: "docker",
      dbServiceName: "pg",
      dbType: "postgres",
      dbName: "hris_staging",
      dbUser: "",
      dbPassword: "typed-pass",
      dbBackupPath: "/backups",
      dbKind: "shared",
      databaseHostId: "h1",
      dbRole: "hris_staging",
      dbPasswordVariable: "DB_PASSWORD",
      frontendServerId: "",
      frontendServiceType: "docker",
      frontendServiceName: "",
      backendMockTimeApiUrl: "",
      backendMockTimeApiKey: "",
    };

  it("sends the binding for shared and drops the derived fields and password", () => {
    for (const modeType of ["create", "edit"] as const) {
      const payload = buildEnvironmentPayload(values, modeType) as Record<
        string,
        unknown
      >;
      expect(payload).toMatchObject({
        dbKind: "shared",
        databaseHostId: "h1",
        dbRole: "hris_staging",
        dbPasswordVariable: "DB_PASSWORD",
        dbName: "hris_staging",
      });
      for (const key of [
        "dbServerId",
        "dbServiceType",
        "dbServiceName",
        "dbType",
        "dbBackupPath",
        "dbUser",
        "dbPassword",
      ]) {
        expect(payload).not.toHaveProperty(key);
      }
    }
  });

  it("sends only the kind for container and external, with the legacy fields", () => {
    for (const dbKind of ["container", "external"] as const) {
      const payload = buildEnvironmentPayload(
        { ...values, dbKind },
        "create"
      ) as Record<string, unknown>;
      expect(payload.dbKind).toBe(dbKind);
      for (const key of ["databaseHostId", "dbRole", "dbPasswordVariable"]) {
        expect(payload).not.toHaveProperty(key);
      }
      expect(payload).toMatchObject({
        dbServerId: "srv-db",
        dbServiceName: "pg",
        dbBackupPath: "/backups",
        dbPassword: null,
      });
    }
  });

  it("sends no binding fields when the kind is unset", () => {
    const payload = buildEnvironmentPayload(
      { ...values, dbKind: "" },
      "edit"
    ) as Record<string, unknown>;
    for (const key of [
      "dbKind",
      "databaseHostId",
      "dbRole",
      "dbPasswordVariable",
    ]) {
      expect(payload).not.toHaveProperty(key);
    }
    expect(payload.dbPassword).toBe("typed-pass");
  });

  it("sends nothing database-related when the database is off", () => {
    const payload = buildEnvironmentPayload(
      { ...values, hasDatabase: false },
      "create"
    ) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("dbKind");
    expect(payload).not.toHaveProperty("dbName");
    expect(payload).not.toHaveProperty("dbPassword");
  });
});

describe("suggestSharedDbName", () => {
  it("joins the lowercased project key and the slug with underscores", () => {
    expect(suggestSharedDbName("HRIS", "staging-2")).toBe("hris_staging_2");
    expect(suggestSharedDbName("hris", "")).toBe("hris");
    expect(suggestSharedDbName("hris", "QA (137)")).toBe("hris_qa_137");
  });

  it("stays within the 63-character identifier limit", () => {
    expect(suggestSharedDbName("hris", "x".repeat(100))).toHaveLength(63);
  });
});
