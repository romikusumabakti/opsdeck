// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { IntlProvider } from "use-intl";
import { describe, expect, it } from "vitest";
import { ProjectRoleProvider } from "@/components/project-role";
import {
  databaseBindingPayload,
  suggestSharedDbName,
} from "@/lib/environment-database-binding";
import type { ProvisioningStepSpec } from "@/lib/provisioning/plan";
import type { ProvisioningStep } from "@/web/api/provisioning";
import messages from "../messages/en.json";
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

function wrap(
  node: React.ReactNode,
  role: "viewer" | "maintainer" = "maintainer"
) {
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

  function panel(role: "viewer" | "maintainer") {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["provisioning", "getProvisioning", "e1"], {
      steps: [],
      plan,
      activeRunId: null,
    });
    return renderToString(
      <QueryClientProvider client={queryClient}>
        {wrap(
          <ProvisioningPanel environment={environment} targets={targets} />,
          role
        )}
      </QueryClientProvider>
    );
  }

  it("is shown to a maintainer", () => {
    expect(panel("maintainer")).toContain(">Provision<");
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
