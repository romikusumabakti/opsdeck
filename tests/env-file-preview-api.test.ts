import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// GET /api/environments/:id/env-file/preview end to end through the Hono
// app: the SSH reader and the repositories faked, the render, the per-dir
// inputs (managedEnvFileInputs) and the diff real. Fixtures are fictional.

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const REGISTRY = "registry.example.test:5000";

const STORED_SECRET = "FAKE_STORED_SECRET_4b1e";
const FILE_SECRET = "FAKE_FILE_SECRET_8d2a";
const FILE_SECRET_B = "FAKE_FILE_SECRET_B_77f0";
const ADDED_SECRET = "FAKE_ADDED_SECRET_31c9";

type Kind = "plain" | "secret" | "generated";

const state = vi.hoisted(() => ({
  role: "engineer" as string | null,
  signInMethod: "passkey" as string,
}));

const store = vi.hoisted(() => ({
  env: {
    id: "0197f3a0-1b2c-7def-8000-0123456789e1",
    name: "Kestrel Dev",
    slug: "dev",
    url: "https://dev.example.test" as string | null,
    appId: null as string | null,
    envFileManaged: false,
  },
  vars: [] as { name: string; kind: string; value: string }[],
  dirs: [] as unknown[],
  tags: ["IMAGE_TAG"] as string[],
  services: ["api"] as string[],
  network: null as string | null,
  sharedDirs: [] as string[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "0197f3a0-1b2c-7def-8000-0123456789a1", role: "engineer" },
    session: { signInMethod: state.signInMethod },
  })),
}));

vi.mock("@/lib/authz", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/authz")>();
  const { canProject } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    ...real,
    requireProjectPermission: vi.fn(
      async (_scope: unknown, perms: Parameters<typeof canProject>[1]) => {
        if (!state.role) throw new HTTPException(404, { message: "Not Found" });
        if (!canProject(state.role as "viewer", perms)) {
          throw new HTTPException(403, { message: "Forbidden" });
        }
        return {
          session: {
            user: { id: "0197f3a0-1b2c-7def-8000-0123456789a1", name: "Romi" },
            session: { signInMethod: state.signInMethod },
          },
          role: state.role,
          projectId: "project-1",
        };
      }
    ),
  };
});

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/activity", () => activity);

vi.mock("@/lib/variables/server-env", () => ({
  readEnvironmentEnvFiles: vi.fn(async () =>
    (store.dirs as object[]).map((d) => ({ ...d }))
  ),
}));

vi.mock("@/lib/variables/repository", () => ({
  getEnvironmentContext: vi.fn(async (environmentId: string) =>
    environmentId === store.env.id ? { ...store.env } : undefined
  ),
  listVariables: vi.fn(async () =>
    store.vars.map((v) => ({ ...v, escrow: false, updatedByName: null }))
  ),
  getSharedDatabaseNetwork: vi.fn(async () => store.network),
}));

vi.mock("@/lib/deploy/repository", () => ({
  listTagVariablesInDeployDir: vi.fn(async () => [...store.tags]),
  listServicesInDeployDir: vi.fn(async () => [...store.services]),
  deployDirSharedWithOtherEnvironment: vi.fn(
    async (_server: string, deployDir: string) =>
      store.sharedDirs.includes(deployDir)
  ),
}));

const { app } = await import("@/server/app");
const serverEnv = await import("@/lib/variables/server-env");
const { encryptSecret } = await import("@/lib/secrets");

const url = `/api/environments/${ENV_ID}/env-file/preview`;

function variable(name: string, kind: Kind, plain: string) {
  return {
    name,
    kind,
    value: kind === "plain" ? plain : encryptSecret(plain),
  };
}

function okDir(deployDir: string, text: string, overridePresent = false) {
  return {
    serverId: "srv-1",
    serverName: "kestrel-app",
    deployDir,
    status: "ok",
    overridePresent,
    text,
    fingerprint: `fp-${deployDir}`,
  };
}

function failedDir(deployDir: string, status: string) {
  return { serverId: "srv-2", serverName: "kestrel-db", deployDir, status };
}

// Hand-written: comments, `export`, other quoting and order than the Panel's.
const LIVE = [
  "# Kestrel API",
  "LOG_LEVEL=info",
  'export APP_NAME="kestrel"',
  `DB_PASSWORD=${FILE_SECRET}`,
  `LEGACY_API_KEY='${FILE_SECRET_B}'`,
  "IMAGE_TAG=1.4.0",
  "DOCKER_REGISTRY=registry.old.example.test",
  "COMPOSE_PROJECT_NAME=kestrel",
  "COMPOSE_FILE=compose.yaml:compose.extra.yaml",
  "COMPOSE_PROFILES=worker",
  "",
].join("\n");

type Change = {
  name: string;
  status: string;
  masked: boolean;
  menaraWritten: boolean;
  reserved: boolean;
  before?: string;
  after?: string;
};
type PreviewDir = {
  serverName: string;
  deployDir: string;
  status: string;
  sharedDir?: boolean;
  changes: Change[];
  unchangedCount: number;
};

const logs = { lines: [] as string[] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEPLOY_REGISTRY", REGISTRY);
  state.role = "engineer";
  state.signInMethod = "passkey";
  store.tags = ["IMAGE_TAG"];
  store.services = ["api"];
  store.network = null;
  store.sharedDirs = [];
  store.vars = [
    variable("APP_NAME", "plain", "kestrel"),
    variable("DB_PASSWORD", "secret", STORED_SECRET),
    variable("NEW_FLAG", "plain", "on"),
    variable("SMTP_TOKEN", "secret", ADDED_SECRET),
  ];
  store.dirs = [
    okDir("/srv/kestrel/api", LIVE),
    { ...failedDir("/srv/kestrel/web", "fileMissing"), serverId: "srv-1" },
    failedDir("/srv/kestrel/db", "unreachable"),
  ];
  logs.lines = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.lines.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function preview(): Promise<{ dirs: PreviewDir[] }> {
  const res = await app.request(url);
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  return (await res.json()) as { dirs: PreviewDir[] };
}

function expectNothingLeaked(raw: string) {
  for (const secret of [
    STORED_SECRET,
    FILE_SECRET,
    FILE_SECRET_B,
    ADDED_SECRET,
  ]) {
    expect(raw).not.toContain(secret);
    expect(logs.lines.join("\n")).not.toContain(secret);
  }
  expect(activity.recordActivity).not.toHaveBeenCalled();
}

describe("permissions", () => {
  for (const role of ["qa", "viewer"]) {
    it(`the ${role} project role gets 403 and reads no server`, async () => {
      state.role = role;
      expect((await app.request(url)).status).toBe(403);
      expect(serverEnv.readEnvironmentEnvFiles).not.toHaveBeenCalled();
    });
  }

  it("needs variable:read and deploy:configure", async () => {
    const authz = await import("@/lib/authz");
    await preview();
    expect(authz.requireProjectPermission).toHaveBeenCalledWith(
      { environmentId: ENV_ID },
      { variable: ["read"], deploy: ["configure"] }
    );
  });

  it("refuses a weak session like the reveal does, before any read", async () => {
    state.signInMethod = "password";
    const res = await app.request(url);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "strong_sign_in_required" });
    expect(serverEnv.readEnvironmentEnvFiles).not.toHaveBeenCalled();
  });

  it("answers 404 for an environment the caller cannot see", async () => {
    state.role = null;
    expect((await app.request(url)).status).toBe(404);
  });
});

describe("the per-dir diff", () => {
  it("compares semantically and flags masked, menaraWritten and reserved keys", async () => {
    const res = await app.request(url);
    const raw = await res.clone().text();
    const body = (await res.json()) as { dirs: PreviewDir[] };
    const api = body.dirs.find((d) => d.deployDir === "/srv/kestrel/api");
    expect(api).toMatchObject({
      serverName: "kestrel-app",
      status: "compared",
    });
    expect(api?.sharedDir).toBeUndefined();
    // APP_NAME (re-quoted, `export`) and IMAGE_TAG (the live tag) are the same.
    expect(api?.unchangedCount).toBe(2);
    expect(api?.changes).toEqual([
      {
        name: "COMPOSE_FILE",
        status: "removed",
        masked: false,
        menaraWritten: false,
        reserved: true,
        before: "compose.yaml:compose.extra.yaml",
      },
      {
        name: "COMPOSE_PROFILES",
        status: "removed",
        masked: false,
        menaraWritten: false,
        reserved: false,
        before: "worker",
      },
      {
        name: "COMPOSE_PROJECT_NAME",
        status: "removed",
        masked: false,
        menaraWritten: false,
        reserved: true,
        before: "kestrel",
      },
      {
        name: "DB_PASSWORD",
        status: "changed",
        masked: true,
        menaraWritten: false,
        reserved: false,
      },
      {
        name: "DOCKER_REGISTRY",
        status: "changed",
        masked: false,
        menaraWritten: true,
        reserved: false,
        before: "registry.old.example.test",
        after: REGISTRY,
      },
      {
        name: "LEGACY_API_KEY",
        status: "removed",
        masked: true,
        menaraWritten: false,
        reserved: false,
      },
      {
        name: "LOG_LEVEL",
        status: "removed",
        masked: false,
        menaraWritten: false,
        reserved: false,
        before: "info",
      },
      {
        name: "NEW_FLAG",
        status: "added",
        masked: false,
        menaraWritten: false,
        reserved: false,
        after: "on",
      },
      {
        name: "SMTP_TOKEN",
        status: "added",
        masked: true,
        menaraWritten: false,
        reserved: false,
      },
    ]);
    expectNothingLeaked(raw);
  });

  it("a missing file shows every key as added, a tag as set at the next deploy", async () => {
    const body = await preview();
    const web = body.dirs.find((d) => d.deployDir === "/srv/kestrel/web");
    expect(web?.status).toBe("fileMissing");
    expect(web?.unchangedCount).toBe(0);
    expect(web?.changes.every((c) => c.status === "added")).toBe(true);
    expect(web?.changes.map((c) => c.name)).toEqual([
      "APP_NAME",
      "DB_PASSWORD",
      "DOCKER_REGISTRY",
      "IMAGE_TAG",
      "NEW_FLAG",
      "SMTP_TOKEN",
    ]);
    expect(web?.changes.find((c) => c.name === "IMAGE_TAG")).toEqual({
      name: "IMAGE_TAG",
      status: "added",
      masked: false,
      menaraWritten: true,
      reserved: false,
    });
  });

  it("a missing deploy dir is a missing file", async () => {
    store.dirs = [
      { ...failedDir("/srv/kestrel/new", "dirMissing"), serverId: "srv-1" },
    ];
    const body = await preview();
    expect(body.dirs[0]?.status).toBe("fileMissing");
    expect(body.dirs[0]?.changes.length).toBeGreaterThan(0);
  });

  it("a dir that cannot be read or parsed is not compared", async () => {
    store.dirs = [
      "unreachable",
      "hostKeyMismatch",
      "parseError",
      "tooLarge",
    ].map((status, i) => failedDir(`/srv/kestrel/d${i}`, status));
    const body = await preview();
    expect(body.dirs).toEqual(
      ["d0", "d1", "d2", "d3"].map((d) => ({
        serverName: "kestrel-db",
        deployDir: `/srv/kestrel/${d}`,
        status: "notCompared",
        changes: [],
        unchangedCount: 0,
      }))
    );
  });

  it("a live tag that is not a valid tag is replaced at the next deploy", async () => {
    store.dirs = [okDir("/srv/kestrel/api", "IMAGE_TAG='not a tag'\n")];
    const body = await preview();
    expect(body.dirs[0]?.changes.find((c) => c.name === "IMAGE_TAG")).toEqual({
      name: "IMAGE_TAG",
      status: "changed",
      masked: false,
      menaraWritten: true,
      reserved: false,
      before: "not a tag",
    });
  });

  it("with a shared database network, COMPOSE_FILE gets the server's override as the deploy script inserts it", async () => {
    store.network = "shared-postgres";
    store.dirs = [
      okDir(
        "/srv/kestrel/api",
        "COMPOSE_FILE=compose.yaml:compose.override.yaml:compose.menara.yaml\n",
        true
      ),
      okDir("/srv/kestrel/web", "IMAGE_TAG=1.4.0\n", false),
    ];
    const body = await preview();
    const [api, web] = body.dirs;
    expect(api?.changes.find((c) => c.name === "COMPOSE_FILE")).toBeUndefined();
    expect(web?.changes.find((c) => c.name === "COMPOSE_FILE")).toEqual({
      name: "COMPOSE_FILE",
      status: "added",
      masked: false,
      menaraWritten: true,
      reserved: false,
      after: "compose.yaml:compose.menara.yaml",
    });
  });

  it("marks a dir another environment also deploys into", async () => {
    store.sharedDirs = ["/srv/kestrel/api"];
    const body = await preview();
    expect(
      body.dirs.find((d) => d.deployDir === "/srv/kestrel/api")
    ).toMatchObject({ sharedDir: true });
    expect(
      body.dirs.find((d) => d.deployDir === "/srv/kestrel/web")?.sharedDir
    ).toBeUndefined();
  });

  it("works on a managed environment too (hand edits since the last deploy)", async () => {
    store.env.envFileManaged = true;
    try {
      const body = await preview();
      expect(body.dirs[0]?.status).toBe("compared");
    } finally {
      store.env.envFileManaged = false;
    }
  });

  it("answers 503 deployDisabled when DEPLOY_REGISTRY is unset", async () => {
    vi.stubEnv("DEPLOY_REGISTRY", "");
    const res = await app.request(url);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "deployDisabled" });
    expect(serverEnv.readEnvironmentEnvFiles).not.toHaveBeenCalled();
  });
});
