import { describe, expect, it } from "vitest";
import type { BuildSpec } from "@/lib/ci/build-spec";
import { generateWoodpeckerPipeline } from "@/lib/ci/pipeline";
import { detectRepo, type RepoDetection } from "@/lib/setup/detect";
import type { CopySourceLike } from "@/lib/setup/draft";
import {
  type NewEnvironmentContext,
  type NewEnvironmentInput,
  newEnvironmentInputSchema,
  resolveNewEnvironment,
} from "@/lib/setup/new-environment";

const PROJECT = "0197f3a0-1b2c-7def-8000-000000000001";
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

const known = (componentKey: string) => ({ componentKey });

function context(
  overrides: Partial<NewEnvironmentContext> = {}
): NewEnvironmentContext {
  return {
    project: { id: PROJECT, key: "CNRY", defaultServerId: SERVER },
    servers: [
      {
        id: SERVER,
        name: ".10.129",
        placement: "open",
        databaseHostId: DB_HOST,
      },
      {
        id: SERVER_2,
        name: ".10.115",
        placement: "restricted",
        databaseHostId: null,
      },
    ],
    repos: [
      {
        repoFullName: "acme/canary-a",
        ciConnectionId: CI,
        detection: detection(),
        component: known("canary-a"),
      },
    ],
    services: [],
    templateNames: [],
    repoOf: {},
    slug: "canary-2",
    copySource: null,
    suggestedPort: 8104,
    defaultZoneId: ZONE,
    defaultAccessPolicyId: "policy-internal",
    zones: [{ id: ZONE, name: "example.net" }],
    existingDbNames: [],
    takenComponentKeys: ["canary-a"],
    ...overrides,
  };
}

function input(
  overrides: Partial<NewEnvironmentInput> = {}
): NewEnvironmentInput {
  return {
    projectId: PROJECT,
    name: "Canary 2",
    services: [],
    repos: [
      {
        ciConnectionId: CI,
        repoFullName: "acme/canary-a",
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
    repos: [
      {
        repoFullName: "acme/canary-b",
        ciConnectionId: CI,
        detection: detection({ pipeline }),
        component: null,
      },
    ],
    takenComponentKeys: [],
  });
const freshInput = input({
  repos: [
    {
      ciConnectionId: CI,
      repoFullName: "acme/canary-b",
      branch: "develop",
    },
  ],
});

const source: CopySourceLike = {
  environment: { id: SOURCE_ENV },
  serverId: SERVER,
  targets: [
    {
      componentKey: "canary-a",
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

describe("environmentSetupInputSchema legacy appId", () => {
  it("accepts and ignores an appId from an old browser tab", async () => {
    const { environmentSetupInputSchema } = await import("@/lib/setup/schema");
    const base = {
      projectId: PROJECT,
      name: "Legacy",
      server: { serverId: SERVER },
      targets: [],
      services: [],
      database: { kind: "none" },
      domain: { kind: "none" },
    };
    const legacy = environmentSetupInputSchema.safeParse({
      ...base,
      appId: "0197f3a0-1b2c-7def-8000-0000000000aa",
    });
    // Only the unknown-key refusal would name appId; the empty targets is
    // refused for its own reason.
    expect(
      legacy.success
        ? []
        : legacy.error.issues.filter((i) => i.code === "unrecognized_keys")
    ).toEqual([]);
  });
});

describe("newEnvironmentInputSchema", () => {
  it("accepts the short input and refuses more than 20 repos", () => {
    expect(newEnvironmentInputSchema.safeParse(input()).success).toBe(true);
    const many = Array.from({ length: 21 }, (_, i) => ({
      ciConnectionId: CI,
      repoFullName: `acme/repo-${i}`,
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
    expect(plan.summary.serverName).toBe(".10.129");
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
        project: { id: PROJECT, key: "CNRY", defaultServerId: null },
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
      context({ project: { id: PROJECT, key: "CNRY", defaultServerId: null } })
    );
    expect(plan.issues).toContainEqual({ field: "serverId", code: "required" });
  });

  it("never uses a default server the caller may not place on", () => {
    const hidden = "0197f3a0-1b2c-7def-8000-0000000000ee";
    const project = { id: PROJECT, key: "CNRY", defaultServerId: hidden };
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

  it("derives names from the context's unique slug", () => {
    const plan = resolveNewEnvironment(
      input({ name: "Canary", needsDatabase: true }),
      context({ slug: "canary-3" })
    );
    expect(plan.setup.targets[0]?.deployDir).toBe("/deployments/cnry-canary-3");
    expect(plan.setup.database).toMatchObject({ dbName: "cnry_canary_3" });
    expect(plan.setup.domain).toMatchObject({ label: "cnry-canary-3" });
  });

  it("fits long names into 63 characters", () => {
    // 60 characters; the 63-character cut of `cnry-<slug>` ends on the `-`.
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

  it("deploys repos whose services came from two former apps", () => {
    const ctx = context({
      repos: [
        ...context().repos,
        {
          repoFullName: "acme/other",
          ciConnectionId: CI,
          detection: detection(),
          component: known("other"),
        },
      ],
    });
    const plan = resolveNewEnvironment(
      input({
        repos: [
          ...input().repos,
          {
            ciConnectionId: CI,
            repoFullName: "acme/other",
            branch: "main",
          },
        ],
      }),
      ctx
    );
    expect(plan.issues).toEqual([]);
    expect(plan.registrations).toEqual([]);
    expect(plan.setup.targets.map((t) => t.componentKey)).toEqual([
      "canary-a",
      "other",
    ]);
  });

  it("does not register a known repo", () => {
    const plan = resolveNewEnvironment(input(), context());
    expect(plan.registrations).toEqual([]);
    expect(plan.setup.targets.map((t) => t.componentKey)).toEqual(["canary-a"]);
  });

  describe("registers an unknown repo", () => {
    it("generated with the suggested build spec when it has no pipeline", () => {
      const plan = resolveNewEnvironment(freshInput, freshRepo());
      expect(plan.registrations).toHaveLength(1);
      const [reg] = plan.registrations;
      expect(reg).toMatchObject({
        repoFullName: "acme/canary-b",
        ciConnectionId: CI,
        componentKey: "canary-b",
        pipelineMode: "generated",
      });
      expect(reg?.buildSpec?.branches).toEqual(["develop"]);
      expect(reg?.buildSpec?.images.map((i) => i.name)).toEqual([
        "canary-b",
        "canary-b-api",
      ]);
      expect(plan.setup.targets[0]?.sourceBranch).toBe("develop");
      expect(plan.issues).toEqual([]);
    });

    it("custom without a build spec, warning when it does not notify", () => {
      const quiet = resolveNewEnvironment(
        freshInput,
        freshRepo({ kind: "custom", notifiesMenara: false })
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
        freshRepo({ kind: "custom", notifiesMenara: true })
      );
      expect(notifying.warnings).toEqual([]);
    });

    it("an old generated pipeline is regenerated to notify-menara", () => {
      const old =
        "# Generated by Acme Panel for canary-old — edit the build spec in the Panel, not this file.\nsteps:\n  - name: notify-panel\n";
      const pipeline = detectRepo([
        { path: ".woodpecker.yaml", content: old },
      ]).pipeline;
      expect(pipeline).toEqual({ kind: "menara", componentKey: "canary-old" });
      const plan = resolveNewEnvironment(freshInput, freshRepo(pipeline));
      expect(plan.registrations[0]).toMatchObject({
        componentKey: "canary-old",
        pipelineMode: "generated",
      });
      expect(
        generateWoodpeckerPipeline(
          "canary-old",
          plan.registrations[0]?.buildSpec as BuildSpec,
          {
            registry: "registry.example.com",
            menaraUrl: "https://ops.example.com",
          }
        )
      ).toContain("- name: notify-menara");
    });

    it("keeps the component key a Menara-generated file names", () => {
      const plan = resolveNewEnvironment(
        freshInput,
        freshRepo({ kind: "menara", componentKey: "canary-old" })
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
            repoFullName: "acme/canary-b",
            mode: "generated",
            buildSpec: spec,
          },
        ]),
        freshRepo({ kind: "custom", notifiesMenara: false })
      );
      expect(generated.registrations[0]).toMatchObject({
        pipelineMode: "generated",
        buildSpec: spec,
      });
      expect(generated.warnings).toEqual([]);
      const custom = resolveNewEnvironment(
        choose([{ repoFullName: "acme/canary-b", mode: "custom" }]),
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
        choose([{ repoFullName: "acme/canary-b", mode: "custom" }]),
        freshRepo({ kind: "custom", notifiesMenara: true })
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
            repoFullName: "acme/canary-b",
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
            repoFullName: "acme/canary-b",
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
                repoFullName: "acme/canary-a",
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
              repoFullName: "acme/canary-b",
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
    ).toBe("canary-b");
    const taken = resolveNewEnvironment(freshInput, {
      ...freshRepo(),
      takenComponentKeys: ["canary-b"],
    });
    expect(taken.registrations[0]?.componentKey).toBe("canary-b-2");
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
        dbName: "cnry_canary_2",
        dbRole: "cnry_canary_2",
        passwordVariable: "DB_PASSWORD",
      });
      expect(plan.summary.databaseName).toBe("cnry_canary_2");
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
        serviceName: "cnry-canary-2-db-1",
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
      context({ existingDbNames: ["cnry_canary"] })
    );
    expect(plan.setup.database).toMatchObject({
      kind: "shared",
      dbName: "cnry_canary2",
      dbRole: "cnry_canary2",
    });
    const both = resolveNewEnvironment(
      input({ needsDatabase: true }),
      context({ existingDbNames: ["cnry_canary", "cnry_canary2"] })
    );
    expect(both.setup.database).toMatchObject({ dbName: "cnry_canary22" });
  });

  it("role follows the database name", () => {
    const plan = resolveNewEnvironment(
      input({
        needsDatabase: true,
        advanced: { database: { kind: "shared", dbName: "cnry_custom" } },
      }),
      context()
    );
    expect(plan.setup.database).toEqual({
      kind: "shared",
      databaseHostId: DB_HOST,
      dbName: "cnry_custom",
      dbRole: "cnry_custom",
      passwordVariable: "DB_PASSWORD",
    });
    const own = resolveNewEnvironment(
      input({
        needsDatabase: true,
        advanced: {
          database: {
            kind: "shared",
            dbName: "cnry_custom",
            dbRole: "cnry_owner",
          },
        },
      }),
      context()
    );
    expect(own.setup.database).toMatchObject({ dbRole: "cnry_owner" });
  });

  describe("address default", () => {
    it("a tunnel on the default zone and policy", () => {
      const plan = resolveNewEnvironment(input(), context());
      expect(plan.setup.domain).toEqual({
        kind: "tunnel",
        zoneId: ZONE,
        label: "cnry-canary-2",
        accessPolicyId: "policy-internal",
        entryPort: 8104,
      });
      expect(plan.summary.url).toBe("https://cnry-canary-2.example.net");
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
      deployDir: "/deployments/cnry-canary-2",
      services: ["api", "web"],
      tagVariable: "IMAGE_TAG",
    });
    expect(plan.setup.entryService).toBe("web");
    expect(plan.setup.services).toEqual([
      { role: "frontend", serviceName: "cnry-canary-2-web-1" },
      { role: "backend", serviceName: "cnry-canary-2-api-1" },
    ]);
  });

  it("copy pre-fills repos and branch", () => {
    const plan = resolveNewEnvironment(
      input({
        repos: [],
        copyFromEnvironmentId: SOURCE_ENV,
        needsDatabase: true,
      }),
      context({ copySource: source, existingDbNames: ["cnry_canary"] })
    );
    expect(plan.issues).toEqual([]);
    expect(plan.registrations).toEqual([]);
    expect(plan.setup.copyFromEnvironmentId).toBe(SOURCE_ENV);
    expect(plan.setup.targets).toEqual([
      {
        componentKey: "canary-a",
        sourceBranch: "release",
        autoDeploy: true,
        deployDir: "/deployments/cnry-canary-2",
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
      dbName: "cnry_canary2",
    });
    // Copied by the copy rules; the port is the new environment's.
    expect(plan.setup.variables).toEqual([
      { name: "MODE", kind: "plain", value: "qa" },
      { name: "API_SECRET", kind: "secret", copy: true },
      { name: "DB_PASSWORD", kind: "generated" },
      { name: "ENTRY_PORT", kind: "plain", value: "8104" },
    ]);
  });

  describe("picks services (Stage 8)", () => {
    const twoServices = (over: Partial<NewEnvironmentContext> = {}) =>
      context({
        repos: [],
        services: [
          { componentKey: "canary-a", detection: detection() },
          { componentKey: "ledger-api", detection: null },
        ],
        takenComponentKeys: ["canary-a", "ledger-api"],
        ...over,
      });

    it("deploys the picked subset of services on their branches", () => {
      const plan = resolveNewEnvironment(
        input({
          repos: [],
          services: [
            { componentKey: "ledger-api", branch: "kestrel/dev" },
            { componentKey: "canary-a", branch: "main" },
          ],
        }),
        twoServices()
      );
      expect(plan.issues).toEqual([]);
      expect(plan.registrations).toEqual([]);
      expect(
        plan.setup.targets.map((t) => [t.componentKey, t.sourceBranch])
      ).toEqual([
        ["ledger-api", "kestrel/dev"],
        ["canary-a", "main"],
      ]);
      // Services of different repositories never share a dir by default:
      // each deploy copies its bundle (compose file included) into the dir.
      expect(plan.setup.targets.map((t) => t.deployDir)).toEqual([
        "/deployments/cnry-canary-2",
        "/deployments/cnry-canary-2-canary-a",
      ]);
      expect(plan.setup).not.toHaveProperty("appId");
    });

    it("lets the services of one repository share the stack dir", () => {
      const repo = "ci:acme/ledger";
      const plan = resolveNewEnvironment(
        input({
          repos: [],
          services: [
            { componentKey: "ledger-api", branch: "main" },
            { componentKey: "ledger-web", branch: "main" },
            { componentKey: "canary-a", branch: "main" },
          ],
        }),
        twoServices({
          services: [
            { componentKey: "ledger-api", detection: null },
            { componentKey: "ledger-web", detection: null },
            { componentKey: "canary-a", detection: detection() },
          ],
          repoOf: {
            "ledger-api": repo,
            "ledger-web": repo,
            "canary-a": "ci:acme/canary-a",
          },
        })
      );
      expect(plan.issues).toEqual([]);
      expect(
        plan.setup.targets.map((t) => [t.componentKey, t.deployDir])
      ).toEqual([
        ["ledger-api", "/deployments/cnry-canary-2"],
        ["ledger-web", "/deployments/cnry-canary-2"],
        ["canary-a", "/deployments/cnry-canary-2-canary-a"],
      ]);
    });

    it("keeps together the services the copy source deploys in one dir", () => {
      const shared = (componentKey: string) => ({
        ...(source.targets[0] as CopySourceLike["targets"][number]),
        componentKey,
        deployDir: "/deployments/cnry-dev",
      });
      const plan = resolveNewEnvironment(
        input({ repos: [], copyFromEnvironmentId: SOURCE_ENV }),
        context({
          repos: [],
          copySource: {
            ...source,
            targets: [shared("core-api"), shared("core-web")],
          },
          // Two repositories, one stack in the source.
          repoOf: { "core-api": "ci:acme/api", "core-web": "ci:acme/web" },
        })
      );
      expect(plan.setup.targets.map((t) => t.deployDir)).toEqual([
        "/deployments/cnry-canary-2",
        "/deployments/cnry-canary-2",
      ]);
    });

    it("joins a service of a copied repository to that repository's dir", () => {
      const shared = (componentKey: string) => ({
        ...(source.targets[0] as CopySourceLike["targets"][number]),
        componentKey,
        deployDir: "/deployments/cnry-dev",
      });
      const plan = resolveNewEnvironment(
        input({
          repos: [],
          copyFromEnvironmentId: SOURCE_ENV,
          services: [
            { componentKey: "core-api", branch: "main" },
            { componentKey: "core-worker", branch: "main" },
          ],
        }),
        context({
          repos: [],
          services: [
            { componentKey: "core-api", detection: null },
            { componentKey: "core-worker", detection: null },
          ],
          copySource: { ...source, targets: [shared("core-api")] },
          // core-worker shares core-api's repository but is not in the source.
          repoOf: {
            "core-api": "ci:acme/core",
            "core-worker": "ci:acme/core",
          },
          takenComponentKeys: ["core-api", "core-worker"],
        })
      );
      expect(plan.issues).toEqual([]);
      expect(plan.setup.targets.map((t) => t.deployDir)).toEqual([
        "/deployments/cnry-canary-2",
        "/deployments/cnry-canary-2",
      ]);
    });

    it("gives later services of a shared dir their own tag variable", () => {
      const plan = resolveNewEnvironment(
        input({
          repos: [],
          services: [
            { componentKey: "core-api", branch: "main" },
            { componentKey: "core-worker-job", branch: "main" },
            { componentKey: "other-web", branch: "main" },
          ],
        }),
        context({
          repos: [],
          services: ["core-api", "core-worker-job", "other-web"].map(
            (componentKey) => ({ componentKey, detection: null })
          ),
          repoOf: {
            "core-api": "ci:acme/core",
            "core-worker-job": "ci:acme/core",
            "other-web": "ci:acme/other",
          },
          takenComponentKeys: ["core-api", "core-worker-job", "other-web"],
        })
      );
      expect(
        plan.setup.targets.map((t) => [t.deployDir, t.tagVariable])
      ).toEqual([
        ["/deployments/cnry-canary-2", "IMAGE_TAG"],
        ["/deployments/cnry-canary-2", "IMAGE_TAG_CORE_WORKER_JOB"],
        ["/deployments/cnry-canary-2-other-web", "IMAGE_TAG"],
      ]);
    });

    it("gives a new repository its own dir next to a registered one", () => {
      const plan = resolveNewEnvironment(
        input({
          repos: [
            ...input().repos,
            {
              ciConnectionId: CI,
              repoFullName: "acme/canary-b",
              branch: "main",
            },
          ],
        }),
        context({
          repos: [
            ...context().repos,
            {
              repoFullName: "acme/canary-b",
              ciConnectionId: CI,
              detection: detection(),
              component: null,
            },
          ],
        })
      );
      expect(plan.setup.targets.map((t) => t.deployDir)).toEqual([
        "/deployments/cnry-canary-2",
        "/deployments/cnry-canary-2-canary-b",
      ]);
    });

    it("refuses a service picked twice, unknown, or also picked by its repo", () => {
      const plan = resolveNewEnvironment(
        input({
          services: [
            { componentKey: "canary-a", branch: "main" },
            { componentKey: "canary-a", branch: "dev" },
            { componentKey: "no-such-service", branch: "main" },
          ],
        }),
        twoServices({ repos: context().repos })
      );
      expect(plan.issues).toEqual([
        { field: "services.1", code: "duplicate" },
        { field: "services.2", code: "invalid" },
        { field: "repos.0", code: "duplicate" },
      ]);
      expect(plan.setup.targets.map((t) => t.componentKey)).toEqual([
        "canary-a",
      ]);
    });

    it("copies only the targets and variables of the services both share", () => {
      const copy: CopySourceLike = {
        ...source,
        targets: [
          ...source.targets,
          {
            ...(source.targets[0] as CopySourceLike["targets"][number]),
            componentKey: "billing-web",
          },
        ],
        variables: [
          ...source.variables.map((v) => ({ ...v, definedBy: [] })),
          {
            name: "BILLING_KEY",
            kind: "plain",
            escrow: false,
            hasValue: true,
            copyable: true,
            value: "b",
            definedBy: ["billing-web"],
          },
          {
            name: "SHARED_KEY",
            kind: "plain",
            escrow: false,
            hasValue: true,
            copyable: true,
            value: "s",
            definedBy: ["billing-web", "canary-a"],
          },
        ],
      };
      const plan = resolveNewEnvironment(
        input({
          repos: [],
          copyFromEnvironmentId: SOURCE_ENV,
          services: [
            { componentKey: "canary-a", branch: "main" },
            { componentKey: "ledger-api", branch: "main" },
          ],
        }),
        twoServices({ copySource: copy })
      );
      expect(plan.issues).toEqual([]);
      // The shared service keeps the source's target settings; the other is new.
      expect(plan.setup.targets).toEqual([
        expect.objectContaining({
          componentKey: "canary-a",
          sourceBranch: "main",
          tagVariable: "APP_TAG",
          healthTimeoutSeconds: 300,
        }),
        expect.objectContaining({
          componentKey: "ledger-api",
          tagVariable: "IMAGE_TAG",
          healthTimeoutSeconds: 180,
        }),
      ]);
      const names = plan.setup.variables.map((v) => v.name);
      expect(names).toContain("SHARED_KEY");
      expect(names).toContain("MODE");
      expect(names).not.toContain("BILLING_KEY");

      // A name the new environment's own templates define is kept.
      const kept = resolveNewEnvironment(
        input({
          repos: [],
          copyFromEnvironmentId: SOURCE_ENV,
          services: [{ componentKey: "ledger-api", branch: "main" }],
        }),
        twoServices({ copySource: copy, templateNames: ["BILLING_KEY"] })
      );
      expect(kept.setup.variables.map((v) => v.name)).toContain("BILLING_KEY");
      expect(kept.setup.variables.map((v) => v.name)).not.toContain(
        "SHARED_KEY"
      );
    });
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
          componentKey: "canary-a",
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
