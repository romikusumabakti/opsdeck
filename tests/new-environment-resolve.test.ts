import { describe, expect, it } from "vitest";
import type { RepoDetection } from "@/lib/setup/detect";
import type { CopySourceLike } from "@/lib/setup/draft";
import {
  type NewEnvironmentContext,
  type NewEnvironmentInput,
  newEnvironmentInputSchema,
  resolveNewEnvironment,
} from "@/lib/setup/new-environment";

const PROJECT = "0197f3a0-1b2c-7def-8000-000000000001";
const APP = "0197f3a0-1b2c-7def-8000-000000000002";
const OTHER_APP = "0197f3a0-1b2c-7def-8000-000000000003";
const SERVER = "0197f3a0-1b2c-7def-8000-000000000004";
const SERVER_2 = "0197f3a0-1b2c-7def-8000-000000000005";
const DB_HOST = "0197f3a0-1b2c-7def-8000-000000000006";
const CI = "0197f3a0-1b2c-7def-8000-000000000007";
const ZONE = "0197f3a0-1b2c-7def-8000-000000000008";
const SOURCE_ENV = "0197f3a0-1b2c-7def-8000-000000000009";
const OWNER = "0197f3a0-1b2c-7def-8000-00000000000a";

function detection(overrides: Partial<RepoDetection> = {}): RepoDetection {
  return {
    composeFile: "compose.yaml",
    composeOverrides: [],
    projectName: null,
    services: [
      {
        name: "api",
        image: null,
        build: "api",
        ports: [],
        profiles: [],
        containerName: null,
      },
      {
        name: "web",
        image: null,
        build: ".",
        ports: [{ host: "8080", container: 80 }],
        profiles: [],
        containerName: null,
      },
    ],
    dockerfiles: ["Dockerfile", "api/Dockerfile"],
    pipeline: { kind: "none" },
    entryService: "web",
    entryContainerPort: 80,
    issues: [],
    ...overrides,
  };
}

const known = (componentKey: string, appId = APP, appKey = "pcan") => ({
  componentKey,
  appId,
  appKey,
});

function context(
  overrides: Partial<NewEnvironmentContext> = {}
): NewEnvironmentContext {
  return {
    project: { id: PROJECT, key: "PCAN", defaultServerId: SERVER },
    servers: [
      {
        id: SERVER,
        name: ".56.129",
        placement: "open",
        databaseHostId: DB_HOST,
      },
      {
        id: SERVER_2,
        name: ".56.115",
        placement: "restricted",
        databaseHostId: null,
      },
    ],
    repos: [
      {
        repoFullName: "dss-consulting/panel-canary",
        ciConnectionId: CI,
        detection: detection(),
        component: known("panel-canary"),
      },
    ],
    app: { id: APP, key: "pcan" },
    slug: "canary-2",
    copySource: null,
    suggestedPort: 8104,
    defaultZoneId: ZONE,
    defaultAccessPolicyId: "policy-internal",
    zones: [{ id: ZONE, name: "dssconsulting.id" }],
    existingDbNames: [],
    takenComponentKeys: ["panel-canary"],
    takenAppKeys: ["pcan"],
    ...overrides,
  };
}

function input(
  overrides: Partial<NewEnvironmentInput> = {}
): NewEnvironmentInput {
  return {
    projectId: PROJECT,
    name: "Canary 2",
    repos: [
      {
        ciConnectionId: CI,
        repoFullName: "dss-consulting/panel-canary",
        branch: "main",
      },
    ],
    needsDatabase: false,
    address: { label: "" },
    ...overrides,
  };
}

const freshRepo = (pipeline: RepoDetection["pipeline"] = { kind: "none" }) =>
  context({
    app: null,
    repos: [
      {
        repoFullName: "dss-consulting/panel-canary-2",
        ciConnectionId: CI,
        detection: detection({ pipeline }),
        component: null,
      },
    ],
    takenComponentKeys: [],
    takenAppKeys: [],
  });
const freshInput = input({
  repos: [
    {
      ciConnectionId: CI,
      repoFullName: "dss-consulting/panel-canary-2",
      branch: "develop",
    },
  ],
});

const source: CopySourceLike = {
  environment: { id: SOURCE_ENV },
  serverId: SERVER,
  targets: [
    {
      componentKey: "panel-canary",
      sourceBranch: "release",
      autoDeploy: false,
      services: ["api", "web"],
      tagVariable: "APP_TAG",
      preStartCommand: "./migrate.sh",
      healthUrl: "http://localhost/health",
      healthTimeoutSeconds: 300,
      backupBeforeDeploy: true,
    },
  ],
  database: { kind: "shared", databaseHostId: DB_HOST },
  domain: { kind: "tunnel", zoneId: ZONE, accessPolicyId: "policy-internal" },
  variables: [
    {
      name: "MODE",
      kind: "plain",
      escrow: false,
      hasValue: true,
      copyable: true,
      value: "qa",
    },
    {
      name: "API_SECRET",
      kind: "secret",
      escrow: false,
      hasValue: true,
      copyable: true,
    },
    {
      name: "DB_PASSWORD",
      kind: "generated",
      escrow: false,
      hasValue: true,
      copyable: false,
    },
    {
      name: "ENTRY_PORT",
      kind: "plain",
      escrow: false,
      hasValue: true,
      copyable: true,
      value: "8101",
    },
  ],
};

describe("newEnvironmentInputSchema", () => {
  it("accepts the short input and refuses more than 20 repos", () => {
    expect(newEnvironmentInputSchema.safeParse(input()).success).toBe(true);
    const many = Array.from({ length: 21 }, (_, i) => ({
      ciConnectionId: CI,
      repoFullName: `dss/repo-${i}`,
      branch: "main",
    }));
    expect(
      newEnvironmentInputSchema.safeParse(input({ repos: many })).success
    ).toBe(false);
  });

  it("keeps absent advanced keys absent", () => {
    const parsed = newEnvironmentInputSchema.parse(
      input({ advanced: { kind: "dev" } })
    );
    expect(parsed.advanced).toEqual({ kind: "dev" });
  });
});

describe("resolveNewEnvironment", () => {
  it("uses the project default server", () => {
    const plan = resolveNewEnvironment(input(), context());
    expect(plan.setup.server.serverId).toBe(SERVER);
    expect(plan.summary.serverName).toBe(".56.129");
    expect(plan.issues).toEqual([]);
  });

  it("uses the input server when it is placeable, refuses one that is not", () => {
    expect(
      resolveNewEnvironment(input({ serverId: SERVER_2 }), context()).setup
        .server.serverId
    ).toBe(SERVER_2);
    const plan = resolveNewEnvironment(
      input({ serverId: "0197f3a0-1b2c-7def-8000-0000000000ff" }),
      context()
    );
    expect(plan.issues).toContainEqual({ field: "serverId", code: "invalid" });
  });

  it("no server available", () => {
    const plan = resolveNewEnvironment(
      input(),
      context({
        project: { id: PROJECT, key: "PCAN", defaultServerId: null },
        servers: [],
      })
    );
    expect(plan.issues).toContainEqual({
      field: "serverId",
      code: "noServerAvailable",
    });
  });

  it("asks for a server when the project has no default but servers exist", () => {
    const plan = resolveNewEnvironment(
      input(),
      context({ project: { id: PROJECT, key: "PCAN", defaultServerId: null } })
    );
    expect(plan.issues).toContainEqual({ field: "serverId", code: "required" });
  });

  it("never uses a default server the caller may not place on", () => {
    const hidden = "0197f3a0-1b2c-7def-8000-0000000000ee";
    const project = { id: PROJECT, key: "PCAN", defaultServerId: hidden };
    const plan = resolveNewEnvironment(input(), context({ project }));
    expect(plan.issues).toContainEqual({ field: "serverId", code: "required" });
    expect(plan.setup.server.serverId).toBe("");
    expect(plan.summary.serverName).toBe("");
    const none = resolveNewEnvironment(
      input(),
      context({ project, servers: [] })
    );
    expect(none.issues).toContainEqual({
      field: "serverId",
      code: "noServerAvailable",
    });
    expect(none.setup.server.serverId).toBe("");
  });

  it("refuses the same repo twice", () => {
    const plan = resolveNewEnvironment(
      input({ repos: [...input().repos, ...input().repos] }),
      context()
    );
    expect(plan.issues).toEqual([{ field: "repos.1", code: "duplicate" }]);
    expect(plan.setup.targets).toHaveLength(1);
  });

  it("keeps the existing app's key even without a known repo", () => {
    const plan = resolveNewEnvironment(
      input({ repos: [], copyFromEnvironmentId: SOURCE_ENV }),
      context({ copySource: source, repos: [] })
    );
    expect(plan.appKey).toBe("pcan");
  });

  it("derives names from the context's unique slug", () => {
    const plan = resolveNewEnvironment(
      input({ name: "Canary", needsDatabase: true }),
      context({ slug: "canary-3" })
    );
    expect(plan.setup.targets[0]?.deployDir).toBe("/deployments/pcan-canary-3");
    expect(plan.setup.database).toMatchObject({ dbName: "pcan_canary_3" });
    expect(plan.setup.domain).toMatchObject({ label: "pcan-canary-3" });
  });

  it("fits long names into 63 characters", () => {
    // 60 characters; the 63-character cut of `pcan-<slug>` ends on the `-`.
    const slug = `${"a".repeat(57)}-bb`;
    expect(slug).toHaveLength(60);
    const plan = resolveNewEnvironment(
      input({ needsDatabase: true }),
      context({ slug })
    );
    const db = plan.setup.database;
    if (db.kind !== "shared") throw new Error("shared expected");
    expect(db.dbName.length).toBeLessThanOrEqual(63);
    expect(db.dbName).toMatch(/^[a-z][a-z0-9_]*[a-z0-9]$/);
    expect(db.dbRole).toBe(db.dbName);
    const domain = plan.setup.domain;
    if (domain.kind !== "tunnel") throw new Error("tunnel expected");
    expect(domain.label.length).toBeLessThanOrEqual(63);
    expect(domain.label).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);

    // Taken names: the suffix still fits.
    const taken = resolveNewEnvironment(
      input({ needsDatabase: true }),
      context({ slug, existingDbNames: [db.dbName] })
    );
    const next = taken.setup.database;
    if (next.kind !== "shared") throw new Error("shared expected");
    expect(next.dbName.length).toBeLessThanOrEqual(63);
    expect(next.dbName).not.toBe(db.dbName);
    expect(next.dbName.startsWith(`${db.dbName}_`)).toBe(false);
  });

  it("refuses a repo of another app", () => {
    const ctx = context({
      repos: [
        ...context().repos,
        {
          repoFullName: "dss-consulting/other",
          ciConnectionId: CI,
          detection: detection(),
          component: known("other", OTHER_APP, "other"),
        },
      ],
    });
    const plan = resolveNewEnvironment(
      input({
        repos: [
          ...input().repos,
          {
            ciConnectionId: CI,
            repoFullName: "dss-consulting/other",
            branch: "main",
          },
        ],
      }),
      ctx
    );
    expect(plan.issues).toContainEqual({
      field: "repos.1",
      code: "repoOtherApp",
    });
    expect(plan.registrations).toEqual([]);
  });

  it("does not register a known repo and keeps the app key", () => {
    const plan = resolveNewEnvironment(input(), context());
    expect(plan.registrations).toEqual([]);
    expect(plan.appKey).toBe("pcan");
    expect(plan.setup.targets.map((t) => t.componentKey)).toEqual([
      "panel-canary",
    ]);
  });

  describe("registers an unknown repo", () => {
    it("generated with the suggested build spec when it has no pipeline", () => {
      const plan = resolveNewEnvironment(freshInput, freshRepo());
      expect(plan.registrations).toHaveLength(1);
      const [reg] = plan.registrations;
      expect(reg).toMatchObject({
        repoFullName: "dss-consulting/panel-canary-2",
        ciConnectionId: CI,
        componentKey: "panel-canary-2",
        pipelineMode: "generated",
      });
      expect(reg?.buildSpec?.branches).toEqual(["develop"]);
      expect(reg?.buildSpec?.images.map((i) => i.name)).toEqual([
        "panel-canary-2",
        "panel-canary-2-api",
      ]);
      expect(plan.appKey).toBe("panel-canary-2");
      expect(plan.setup.targets[0]?.sourceBranch).toBe("develop");
      expect(plan.issues).toEqual([]);
    });

    it("custom without a build spec, warning when it does not notify", () => {
      const quiet = resolveNewEnvironment(
        freshInput,
        freshRepo({ kind: "custom", notifiesPanel: false })
      );
      expect(quiet.registrations[0]).toMatchObject({
        pipelineMode: "custom",
        buildSpec: null,
      });
      expect(quiet.warnings).toEqual([
        { field: "repos.0", code: "pipelineNotNotifying" },
      ]);
      const notifying = resolveNewEnvironment(
        freshInput,
        freshRepo({ kind: "custom", notifiesPanel: true })
      );
      expect(notifying.warnings).toEqual([]);
    });

    it("keeps the component key a Panel-generated file names", () => {
      const plan = resolveNewEnvironment(
        freshInput,
        freshRepo({ kind: "panel", componentKey: "canary-old" })
      );
      expect(plan.registrations[0]).toMatchObject({
        componentKey: "canary-old",
        pipelineMode: "generated",
      });
    });

    it("refuses a generated repo without a build spec", () => {
      const ctx = freshRepo();
      const repo = ctx.repos[0];
      if (!repo) throw new Error("fixture");
      repo.detection = detection({ dockerfiles: [] });
      const plan = resolveNewEnvironment(freshInput, ctx);
      expect(plan.issues).toContainEqual({
        field: "repos.0",
        code: "repoNotBuildable",
      });
    });
  });

  describe("an admin's pipeline choice", () => {
    const spec = {
      branches: ["develop", "main"],
      tagShaLength: 7,
      images: [
        { name: "canary", dockerfile: "docker/Dockerfile", context: "." },
      ],
      bundleFiles: [{ from: "deploy/compose.yaml", to: "compose.yaml" }],
      checks: [],
      timeoutMinutes: 60,
    };
    const choose = (
      pipelines: NonNullable<NewEnvironmentInput["advanced"]>["pipelines"]
    ) => input({ ...freshInput, advanced: { pipelines } });

    it("replaces the detected mode and build spec", () => {
      const generated = resolveNewEnvironment(
        choose([
          {
            repoFullName: "dss-consulting/panel-canary-2",
            mode: "generated",
            buildSpec: spec,
          },
        ]),
        freshRepo({ kind: "custom", notifiesPanel: false })
      );
      expect(generated.registrations[0]).toMatchObject({
        pipelineMode: "generated",
        buildSpec: spec,
      });
      expect(generated.warnings).toEqual([]);
      const custom = resolveNewEnvironment(
        choose([
          { repoFullName: "dss-consulting/panel-canary-2", mode: "custom" },
        ]),
        freshRepo()
      );
      expect(custom.registrations[0]).toMatchObject({
        pipelineMode: "custom",
        buildSpec: null,
      });
      expect(custom.issues).toEqual([]);
      // Custom without a pipeline file: a warning, not an issue.
      expect(custom.warnings).toEqual([
        { field: "repos.0", code: "pipelineFileMissing" },
      ]);
      const withFile = resolveNewEnvironment(
        choose([
          { repoFullName: "dss-consulting/panel-canary-2", mode: "custom" },
        ]),
        freshRepo({ kind: "custom", notifiesPanel: true })
      );
      expect(withFile.warnings).toEqual([]);
    });

    it("is the escape from repoNotBuildable", () => {
      const ctx = freshRepo();
      const repo = ctx.repos[0];
      if (!repo) throw new Error("fixture");
      repo.detection = detection({ dockerfiles: [] });
      const plan = resolveNewEnvironment(
        choose([
          {
            repoFullName: "dss-consulting/panel-canary-2",
            mode: "generated",
            buildSpec: spec,
          },
        ]),
        ctx
      );
      expect(plan.issues).toEqual([]);
      expect(plan.registrations[0]?.buildSpec).toEqual(spec);
    });

    it("needs the environment's branch among the built branches", () => {
      const plan = resolveNewEnvironment(
        choose([
          {
            repoFullName: "dss-consulting/panel-canary-2",
            mode: "generated",
            buildSpec: { ...spec, branches: ["main"] },
          },
        ]),
        freshRepo()
      );
      expect(plan.issues).toContainEqual({
        field: "pipelines.0.buildSpec.branches",
        code: "pipelineBranchMissing",
      });
    });

    it("ignores a choice for a repository already registered", () => {
      const plan = resolveNewEnvironment(
        input({
          advanced: {
            pipelines: [
              {
                repoFullName: "dss-consulting/panel-canary",
                mode: "generated",
              },
            ],
          },
        }),
        context()
      );
      expect(plan.registrations).toEqual([]);
      expect(plan.issues).toEqual([]);
    });

    it("refuses an invalid build spec in the schema", () => {
      expect(
        newEnvironmentInputSchema.safeParse(
          choose([
            {
              repoFullName: "dss-consulting/panel-canary-2",
              mode: "generated",
              buildSpec: { ...spec, images: [] },
            },
          ])
        ).success
      ).toBe(false);
    });
  });

  it("component key from slug", () => {
    expect(
      resolveNewEnvironment(freshInput, freshRepo()).registrations[0]
        ?.componentKey
    ).toBe("panel-canary-2");
    const taken = resolveNewEnvironment(freshInput, {
      ...freshRepo(),
      takenComponentKeys: ["panel-canary-2"],
      takenAppKeys: ["panel-canary-2"],
    });
    expect(taken.registrations[0]?.componentKey).toBe("panel-canary-2-2");
    expect(taken.appKey).toBe("panel-canary-2-2");
  });

  describe("database default", () => {
    it("shared on the server's database host", () => {
      const plan = resolveNewEnvironment(
        input({ needsDatabase: true }),
        context()
      );
      expect(plan.setup.database).toEqual({
        kind: "shared",
        databaseHostId: DB_HOST,
        dbName: "pcan_canary_2",
        dbRole: "pcan_canary_2",
        passwordVariable: "DB_PASSWORD",
      });
      expect(plan.summary.databaseName).toBe("pcan_canary_2");
      // The password variable is added as generated.
      expect(plan.setup.variables).toContainEqual({
        name: "DB_PASSWORD",
        kind: "generated",
      });
    });

    it("a container without a host", () => {
      const plan = resolveNewEnvironment(
        input({ needsDatabase: true, serverId: SERVER_2 }),
        context()
      );
      expect(plan.setup.database).toEqual({
        kind: "container",
        serviceName: "pcan-canary-2-db-1",
      });
    });

    it("a container named by the compose file", () => {
      const ctx = context();
      const repo = ctx.repos[0];
      if (!repo) throw new Error("fixture");
      repo.detection = detection({
        projectName: "canary",
        services: [
          ...detection().services,
          {
            name: "db",
            image: "postgres:18",
            build: null,
            ports: [],
            profiles: [],
            containerName: "canary-postgres",
          },
        ],
      });
      const plan = resolveNewEnvironment(
        input({ needsDatabase: true, serverId: SERVER_2 }),
        ctx
      );
      expect(plan.setup.database).toEqual({
        kind: "container",
        serviceName: "canary-postgres",
      });
    });

    it("none when not needed", () => {
      expect(resolveNewEnvironment(input(), context()).setup.database).toEqual({
        kind: "none",
      });
    });
  });

  it("db name never collides with the copy source", () => {
    const plan = resolveNewEnvironment(
      input({ needsDatabase: true }),
      context({ existingDbNames: ["pcan_canary"] })
    );
    expect(plan.setup.database).toMatchObject({
      kind: "shared",
      dbName: "pcan_canary2",
      dbRole: "pcan_canary2",
    });
    const both = resolveNewEnvironment(
      input({ needsDatabase: true }),
      context({ existingDbNames: ["pcan_canary", "pcan_canary2"] })
    );
    expect(both.setup.database).toMatchObject({ dbName: "pcan_canary22" });
  });

  it("role follows the database name", () => {
    const plan = resolveNewEnvironment(
      input({
        needsDatabase: true,
        advanced: { database: { kind: "shared", dbName: "pcan_custom" } },
      }),
      context()
    );
    expect(plan.setup.database).toEqual({
      kind: "shared",
      databaseHostId: DB_HOST,
      dbName: "pcan_custom",
      dbRole: "pcan_custom",
      passwordVariable: "DB_PASSWORD",
    });
    const own = resolveNewEnvironment(
      input({
        needsDatabase: true,
        advanced: {
          database: {
            kind: "shared",
            dbName: "pcan_custom",
            dbRole: "pcan_owner",
          },
        },
      }),
      context()
    );
    expect(own.setup.database).toMatchObject({ dbRole: "pcan_owner" });
  });

  describe("address default", () => {
    it("a tunnel on the default zone and policy", () => {
      const plan = resolveNewEnvironment(input(), context());
      expect(plan.setup.domain).toEqual({
        kind: "tunnel",
        zoneId: ZONE,
        label: "pcan-canary-2",
        accessPolicyId: "policy-internal",
        entryPort: 8104,
      });
      expect(plan.summary.url).toBe("https://pcan-canary-2.dssconsulting.id");
      expect(plan.summary.port).toBe(8104);
    });

    it("keeps a typed label", () => {
      const plan = resolveNewEnvironment(
        input({ address: { label: "canary" } }),
        context()
      );
      expect(plan.setup.domain).toMatchObject({ label: "canary" });
    });

    it("none without an address", () => {
      const plan = resolveNewEnvironment(input({ address: null }), context());
      expect(plan.setup.domain).toEqual({ kind: "none" });
      expect(plan.summary.url).toBeNull();
      expect(plan.summary.port).toBeNull();
    });

    it("reports what the address lacks instead of going public", () => {
      const plan = resolveNewEnvironment(
        input(),
        context({
          suggestedPort: null,
          defaultZoneId: null,
          defaultAccessPolicyId: null,
        })
      );
      expect(plan.issues).toEqual(
        expect.arrayContaining([
          { field: "domain.zoneId", code: "required" },
          { field: "domain.accessPolicyId", code: "required" },
          { field: "domain.entryPort", code: "required" },
        ])
      );
    });
  });

  it("ENTRY_PORT variable", () => {
    const plan = resolveNewEnvironment(input(), context());
    expect(plan.setup.variables).toContainEqual({
      name: "ENTRY_PORT",
      kind: "plain",
      value: "8104",
    });
    const set = resolveNewEnvironment(
      input({
        advanced: {
          variables: [{ name: "ENTRY_PORT", kind: "plain", value: "9000" }],
        },
      }),
      context()
    );
    expect(set.setup.variables).toEqual([
      { name: "ENTRY_PORT", kind: "plain", value: "9000" },
    ]);
    const none = resolveNewEnvironment(input({ address: null }), context());
    expect(none.setup.variables.map((v) => v.name)).not.toContain("ENTRY_PORT");
  });

  it("auto-deploy on for non-prod", () => {
    const plan = resolveNewEnvironment(input(), context());
    expect(plan.setup.targets.every((t) => t.autoDeploy)).toBe(true);
    const prod = resolveNewEnvironment(
      input({ advanced: { kind: "prod" } }),
      context()
    );
    expect(prod.setup.targets.every((t) => !t.autoDeploy)).toBe(true);
  });

  it("fills the targets and container names from detection", () => {
    const plan = resolveNewEnvironment(input(), context());
    expect(plan.setup.targets[0]).toMatchObject({
      deployDir: "/deployments/pcan-canary-2",
      services: ["api", "web"],
      tagVariable: "IMAGE_TAG",
    });
    expect(plan.setup.entryService).toBe("web");
    expect(plan.setup.services).toEqual([
      { role: "frontend", serviceName: "pcan-canary-2-web-1" },
      { role: "backend", serviceName: "pcan-canary-2-api-1" },
    ]);
  });

  it("copy pre-fills repos and branch", () => {
    const plan = resolveNewEnvironment(
      input({
        repos: [],
        copyFromEnvironmentId: SOURCE_ENV,
        needsDatabase: true,
      }),
      context({ copySource: source, existingDbNames: ["pcan_canary"] })
    );
    expect(plan.issues).toEqual([]);
    expect(plan.registrations).toEqual([]);
    expect(plan.setup.copyFromEnvironmentId).toBe(SOURCE_ENV);
    expect(plan.setup.targets).toEqual([
      {
        componentKey: "panel-canary",
        sourceBranch: "release",
        autoDeploy: true,
        deployDir: "/deployments/pcan-canary-2",
        services: ["api", "web"],
        tagVariable: "APP_TAG",
        preStartCommand: "./migrate.sh",
        healthUrl: "http://localhost/health",
        healthTimeoutSeconds: 300,
        backupBeforeDeploy: true,
      },
    ]);
    expect(plan.setup.database).toMatchObject({
      kind: "shared",
      dbName: "pcan_canary2",
    });
    // Copied by the copy rules; the port is the new environment's.
    expect(plan.setup.variables).toEqual([
      { name: "MODE", kind: "plain", value: "qa" },
      { name: "API_SECRET", kind: "secret", copy: true },
      { name: "DB_PASSWORD", kind: "generated" },
      { name: "ENTRY_PORT", kind: "plain", value: "8104" },
    ]);
  });

  it("asks for a repo without one and without a copy source", () => {
    const plan = resolveNewEnvironment(input({ repos: [] }), context());
    expect(plan.issues).toContainEqual({ field: "repos", code: "required" });
  });

  it("advanced overrides win", () => {
    const advanced: NonNullable<NewEnvironmentInput["advanced"]> = {
      kind: "dev",
      ownerId: OWNER,
      services: [{ role: "backend", serviceName: "my-api" }],
      database: { kind: "external" },
      variables: [{ name: "MODE", kind: "plain", value: "dev" }],
      domain: { kind: "external", hostname: "canary.example.com" },
      targets: [
        {
          componentKey: "panel-canary",
          sourceBranch: "feature",
          autoDeploy: false,
          deployDir: "/srv/canary",
          services: ["api"],
          tagVariable: "TAG",
          healthTimeoutSeconds: 60,
          backupBeforeDeploy: false,
        },
      ],
    };
    const plan = resolveNewEnvironment(
      input({ needsDatabase: true, advanced }),
      context()
    );
    expect(plan.setup).toMatchObject({
      kind: "dev",
      ownerId: OWNER,
      services: advanced.services,
      database: { kind: "external" },
      variables: advanced.variables,
      domain: advanced.domain,
      targets: advanced.targets,
    });
    expect(plan.summary.url).toBe("https://canary.example.com");
  });
});
