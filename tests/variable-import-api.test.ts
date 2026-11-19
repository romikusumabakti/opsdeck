/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: .env text */
import { beforeEach, describe, expect, it, vi } from "vitest";

// "Import .env" end to end through the Hono app: the server-source review
// (the SSH reader mocked), the text preview, and the save of either, against
// an in-memory repository and a fake transaction that rolls back on a throw.
// Values really go through lib/secrets. Fixtures are fictional.

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const APP_ID = "0197f3a0-1b2c-7def-8000-0123456789d1";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";

const STORED_SECRET = "FAKE_STORED_SECRET_4b1e";
const FILE_SECRET = "FAKE_FILE_SECRET_8d2a";
const FILE_SECRET_B = "FAKE_FILE_SECRET_B_77f0";

type Kind = "plain" | "secret" | "generated";
type Row = {
  id: string;
  environmentId: string;
  name: string;
  kind: Kind;
  value: string;
  escrow: boolean;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};
type Write = Omit<Row, "id" | "createdAt" | "updatedAt">;
type Dir = {
  serverId: string;
  serverName: string;
  deployDir: string;
  status: string;
  line?: number;
  overridePresent?: boolean;
  text?: string;
  fingerprint?: string;
};

const state = vi.hoisted(() => ({
  role: "engineer" as string | null,
}));

const store = vi.hoisted(() => ({
  env: {
    id: "0197f3a0-1b2c-7def-8000-0123456789e1",
    name: "Kestrel Dev",
    slug: "dev",
    url: "https://dev.example.test" as string | null,
    appId: "0197f3a0-1b2c-7def-8000-0123456789d1" as string | null,
    envFileManaged: false,
  },
  tags: ["IMAGE_TAG"] as string[],
  vars: new Map<string, unknown>(),
  templates: [] as unknown[],
  dirs: [] as unknown[],
  // Set by a test: escrows this name right before the write (a concurrent
  // admin), so the statement leaves it out.
  escrowDuringWrite: null as string | null,
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "0197f3a0-1b2c-7def-8000-0123456789a1", role: "engineer" },
    session: { signInMethod: "passkey" },
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
            session: { signInMethod: "passkey" },
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

const logs = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("@/lib/variables/server-env", () => ({
  readEnvironmentEnvFiles: vi.fn(async () =>
    (store.dirs as object[]).map((d) => ({ ...d }))
  ),
}));

// The transaction: a snapshot of the store, restored when the callback throws.
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...real,
    db: {
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const snapshot = new Map(store.vars);
        try {
          return await fn({ fake: "tx" });
        } catch (error) {
          store.vars = snapshot;
          throw error;
        }
      }),
    },
  };
});

vi.mock("@/lib/variables/repository", () => {
  let seq = 0;
  const id = () => `0197f3a0-1b2c-7def-8000-${String(++seq).padStart(12, "0")}`;
  return {
    getEnvironmentContext: vi.fn(async (environmentId: string) =>
      environmentId === store.env.id ? { ...store.env } : undefined
    ),
    listTagVariableNames: vi.fn(async () => [...store.tags]),
    listVariables: vi.fn(async () =>
      [...(store.vars as Map<string, Row>).values()]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((row) => ({ ...row, updatedByName: null }))
    ),
    listTemplates: vi.fn(async () => [...store.templates]),
    // Mirrors the SQL: one statement, escrowed rows left out.
    importVariables: vi.fn(async (tx: unknown, writes: Write[]) => {
      if ((tx as { fake?: string })?.fake !== "tx") {
        throw new Error("importVariables outside the transaction");
      }
      const vars = store.vars as Map<string, Row>;
      if (store.escrowDuringWrite) {
        const row = vars.get(store.escrowDuringWrite);
        if (row) vars.set(row.name, { ...row, escrow: true });
      }
      const out: { name: string; overwritten: boolean }[] = [];
      for (const write of writes) {
        const existing = vars.get(write.name);
        if (existing?.escrow) continue;
        vars.set(write.name, {
          id: existing?.id ?? id(),
          createdAt: existing?.createdAt ?? new Date(),
          updatedAt: new Date(),
          ...write,
        });
        out.push({ name: write.name, overwritten: existing !== undefined });
      }
      return out;
    }),
  };
});

const { app } = await import("@/server/app");
const repository = await import("@/lib/variables/repository");
const serverEnv = await import("@/lib/variables/server-env");
const authz = await import("@/lib/authz");
const { encryptSecret, decryptSecret } = await import("@/lib/secrets");
const { IMPORT_BODY_LIMIT } = await import("@/server/services/variable-import");

const base = `/api/environments/${ENV_ID}/variables/import`;

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function row(name: string, kind: Kind, plain: string, escrow = false): Row {
  return {
    id: `id-${name}`,
    environmentId: ENV_ID,
    name,
    kind,
    value: kind === "plain" ? plain : encryptSecret(plain),
    escrow,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function dir(deployDir: string, text: string, fingerprint: string): Dir {
  return {
    serverId: "srv-1",
    serverName: "kestrel-app",
    deployDir,
    status: "ok",
    overridePresent: false,
    text,
    fingerprint,
  };
}

const vars = () => store.vars as Map<string, Row>;
const stored = (name: string) => {
  const r = vars().get(name);
  if (!r) return undefined;
  return {
    kind: r.kind,
    escrow: r.escrow,
    value: r.kind === "plain" ? r.value : decryptSecret(r.value),
  };
};

const API_TEXT = `APP_NAME=kestrel\nLOG_LEVEL=info\nDB_PASSWORD=${FILE_SECRET}\nIMAGE_TAG=1.4.0\nDOCKER_REGISTRY=registry.example.test\nCOMPOSE_PROFILES=worker\n`;
const WEB_TEXT = `APP_NAME=kestrel\nLOG_LEVEL=debug\nDB_PASSWORD=${FILE_SECRET_B}\n`;

beforeEach(() => {
  vi.clearAllMocks();
  state.role = "engineer";
  store.env.appId = APP_ID;
  store.tags = ["IMAGE_TAG"];
  store.templates = [];
  store.escrowDuringWrite = null;
  store.vars = new Map<string, Row>([
    ["APP_NAME", row("APP_NAME", "plain", "kestrel")],
    ["DB_PASSWORD", row("DB_PASSWORD", "secret", STORED_SECRET)],
  ]);
  store.dirs = [
    dir("/srv/kestrel/api", API_TEXT, "fp-api"),
    dir("/srv/kestrel/web", WEB_TEXT, "fp-web"),
    {
      serverId: "srv-2",
      serverName: "kestrel-db",
      deployDir: "/srv/kestrel/db",
      status: "unreachable",
    },
  ];
  logs.lines = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.lines.push(args.map(String).join(" "));
    });
  }
});

function expectNoSecretIn(text: string) {
  for (const secret of [STORED_SECRET, FILE_SECRET, FILE_SECRET_B]) {
    expect(text).not.toContain(secret);
  }
}

function expectNothingLeaked() {
  expectNoSecretIn(JSON.stringify(activity.recordActivity.mock.calls));
  expectNoSecretIn(logs.lines.join("\n"));
}

const SAVE_TEXT = {
  source: "text",
  text: "NEW_FLAG=on\n",
  rows: [{ name: "NEW_FLAG", kind: "plain" }],
};
const SAVE_SERVER = {
  source: "server",
  dirs: [
    { deployDir: "/srv/kestrel/api", fingerprint: "fp-api" },
    { deployDir: "/srv/kestrel/web", fingerprint: "fp-web" },
  ],
  rows: [{ name: "COMPOSE_PROFILES", kind: "plain" }],
};

describe("permissions", () => {
  it("an engineer may use every import route", async () => {
    expect((await send("GET", base)).status).toBe(200);
    expect(
      (await send("POST", `${base}/preview`, { source: "text", text: "A=1" }))
        .status
    ).toBe(200);
    expect((await send("POST", base, SAVE_TEXT)).status).toBe(200);
    expect((await send("POST", base, SAVE_SERVER)).status).toBe(200);
  });

  // ba and pm map to the qa project set, staff and observer to viewer.
  for (const role of ["qa", "viewer"]) {
    it(`the ${role} project role (qa, ba, pm, staff, observer) gets 403 and reads nothing`, async () => {
      state.role = role;
      const before = JSON.stringify([...vars().entries()]);
      expect((await send("GET", base)).status).toBe(403);
      expect(
        (await send("POST", `${base}/preview`, { source: "text", text: "A=1" }))
          .status
      ).toBe(403);
      expect((await send("POST", base, SAVE_TEXT)).status).toBe(403);
      expect((await send("POST", base, SAVE_SERVER)).status).toBe(403);
      expect(serverEnv.readEnvironmentEnvFiles).not.toHaveBeenCalled();
      expect(repository.importVariables).not.toHaveBeenCalled();
      expect(JSON.stringify([...vars().entries()])).toBe(before);
      expect(activity.recordActivity).not.toHaveBeenCalled();
    });
  }

  it("maps ba/pm/staff/observer to a project role without import rights", async () => {
    const { projectRoleForOrgRole, canProject } = await import(
      "@/lib/permissions"
    );
    for (const org of ["qa", "ba", "pm", "staff", "observer"]) {
      expect(
        canProject(projectRoleForOrgRole(org), {
          variable: ["read", "write"],
        }),
        org
      ).toBe(false);
    }
  });
});

describe("GET import (server source)", () => {
  it("returns dir statuses, rows and skipped names, never text or a non-plain value", async () => {
    const res = await send("GET", base);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    const raw = JSON.stringify(body);
    expectNoSecretIn(raw);
    expect(raw).not.toContain("serverId");
    expect(raw).not.toContain("overridePresent");
    expect(body.dirs).toEqual([
      {
        serverName: "kestrel-app",
        deployDir: "/srv/kestrel/api",
        status: "ok",
        fingerprint: "fp-api",
      },
      {
        serverName: "kestrel-app",
        deployDir: "/srv/kestrel/web",
        status: "ok",
        fingerprint: "fp-web",
      },
      {
        serverName: "kestrel-db",
        deployDir: "/srv/kestrel/db",
        status: "unreachable",
      },
    ]);
    expect(body.skipped).toEqual([
      { name: "DOCKER_REGISTRY", reason: "dockerRegistry" },
      { name: "IMAGE_TAG", reason: "tagVariable" },
    ]);
    const byName = Object.fromEntries(
      body.rows.map((r: { name: string }) => [r.name, r])
    );
    expect(Object.keys(byName)).toEqual([
      "APP_NAME",
      "COMPOSE_PROFILES",
      "DB_PASSWORD",
      "LOG_LEVEL",
    ]);
    expect(byName.APP_NAME).toMatchObject({ state: "same", value: "kestrel" });
    expect(byName.COMPOSE_PROFILES).toMatchObject({
      state: "new",
      proposedKind: "plain",
      value: "worker",
    });
    // Compared server-side with the stored secret; nothing of it is sent.
    expect(byName.DB_PASSWORD).toMatchObject({
      state: "conflict",
      proposedKind: "secret",
      value: null,
      flags: { differsAcrossDirs: true },
    });
    expect(byName.LOG_LEVEL).toMatchObject({
      state: "new",
      value: null,
      flags: { differsAcrossDirs: true },
      sources: [
        { deployDir: "/srv/kestrel/api", valueId: "fp-api:2", value: "info" },
        { deployDir: "/srv/kestrel/web", valueId: "fp-web:2", value: "debug" },
      ],
    });
    expect(activity.recordActivity).not.toHaveBeenCalled();
    expectNothingLeaked();
  });

  it("proposes the template's generated and escrow kinds", async () => {
    store.templates = [
      { name: "SESSION_KEY", kind: "generated", escrow: true },
    ];
    store.dirs = [
      dir("/srv/kestrel/api", `SESSION_KEY=${FILE_SECRET}\n`, "fp-api"),
    ];
    const body = await (await send("GET", base)).json();
    expect(body.rows).toEqual([
      expect.objectContaining({
        name: "SESSION_KEY",
        proposedKind: "generated",
        value: null,
      }),
    ]);
    const res = await send("POST", base, {
      source: "server",
      dirs: [{ deployDir: "/srv/kestrel/api", fingerprint: "fp-api" }],
      rows: [{ name: "SESSION_KEY", kind: "generated" }],
    });
    expect(res.status).toBe(200);
    // The server value is kept (Regenerate works later); the template escrows it.
    expect(stored("SESSION_KEY")).toEqual({
      kind: "generated",
      escrow: true,
      value: FILE_SECRET,
    });
  });

  it("marks an escrowed variable unimportable", async () => {
    vars().set(
      "DB_PASSWORD",
      row("DB_PASSWORD", "secret", STORED_SECRET, true)
    );
    const body = await (await send("GET", base)).json();
    const password = body.rows.find(
      (r: { name: string }) => r.name === "DB_PASSWORD"
    );
    expect(password).toMatchObject({
      state: "unimportable",
      reason: "escrowed",
      value: null,
    });
  });
});

describe("POST import (server source)", () => {
  it("writes the chosen dir's value for a row whose dirs differ", async () => {
    const res = await send("POST", base, {
      ...SAVE_SERVER,
      rows: [
        { name: "LOG_LEVEL", kind: "plain", valueId: "fp-web:2" },
        { name: "DB_PASSWORD", kind: "secret", valueId: "fp-api:3" },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: 2, overwritten: 1 });
    expect(stored("LOG_LEVEL")).toEqual({
      kind: "plain",
      escrow: false,
      value: "debug",
    });
    expect(stored("DB_PASSWORD")).toEqual({
      kind: "secret",
      escrow: false,
      value: FILE_SECRET,
    });
    // Encrypted at rest.
    expect(vars().get("DB_PASSWORD")?.value).not.toContain(FILE_SECRET);
    expect(vars().get("LOG_LEVEL")?.updatedBy).toBe(USER_ID);
    expect(activity.recordActivity).toHaveBeenCalledWith({
      actorId: USER_ID,
      action: "variables.imported",
      entityType: "environment",
      entityId: ENV_ID,
      data: {
        environment: "Kestrel Dev",
        source: "server",
        names: "DB_PASSWORD, LOG_LEVEL",
        overwritten: "DB_PASSWORD",
        dirs: "kestrel-app:/srv/kestrel/api, kestrel-app:/srv/kestrel/web",
      },
    });
    expectNothingLeaked();
  });

  it("refuses a differing row without a dir choice", async () => {
    const res = await send("POST", base, {
      ...SAVE_SERVER,
      rows: [{ name: "LOG_LEVEL", kind: "plain" }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "importSourceRequired",
      params: { name: "LOG_LEVEL" },
    });
    expect(vars().has("LOG_LEVEL")).toBe(false);
  });

  it("answers 409 envFileChanged and writes nothing when a file changed since the review", async () => {
    const before = JSON.stringify([...vars().entries()]);
    store.dirs = [
      dir("/srv/kestrel/api", `${API_TEXT}EXTRA=1\n`, "fp-api-2"),
      dir("/srv/kestrel/web", WEB_TEXT, "fp-web"),
    ];
    const res = await send("POST", base, SAVE_SERVER);
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ code: "envFileChanged" });
    expectNoSecretIn(body);
    expect(repository.importVariables).not.toHaveBeenCalled();
    expect(JSON.stringify([...vars().entries()])).toBe(before);
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("answers 409 envFileChanged when a dir became unreadable or readable", async () => {
    store.dirs = [dir("/srv/kestrel/api", API_TEXT, "fp-api")];
    expect((await send("POST", base, SAVE_SERVER)).status).toBe(409);
    store.dirs = [
      dir("/srv/kestrel/api", API_TEXT, "fp-api"),
      dir("/srv/kestrel/web", WEB_TEXT, "fp-web"),
      dir("/srv/kestrel/db", "X=1\n", "fp-db"),
    ];
    expect((await send("POST", base, SAVE_SERVER)).status).toBe(409);
  });

  it("refuses same, unimportable and unknown rows with 400", async () => {
    vars().set("LOG_LEVEL", row("LOG_LEVEL", "plain", "x", true));
    for (const [name, code] of [
      ["APP_NAME", "importRowSame"],
      ["LOG_LEVEL", "importRowUnimportable"],
      ["IMAGE_TAG", "importRowUnknown"],
      ["NOT_IN_FILE", "importRowUnknown"],
    ] as const) {
      const res = await send("POST", base, {
        ...SAVE_SERVER,
        rows: [
          {
            name,
            kind: "plain",
            ...(name === "LOG_LEVEL" ? { valueId: "fp-api:2" } : {}),
          },
        ],
      });
      expect(res.status, name).toBe(400);
      expect((await res.json()).code, name).toBe(code);
    }
    expect(repository.importVariables).not.toHaveBeenCalled();
  });
});

describe("POST import/preview (text source)", () => {
  it("compares pasted text server-side and masks secrets", async () => {
    const res = await send("POST", `${base}/preview`, {
      source: "text",
      text: `APP_NAME=kestrel\nDB_PASSWORD=${FILE_SECRET}\nREDIS_URL=redis://:${FILE_SECRET}@cache:6379\nEXTERNAL=\${HOST_FROM_SHELL}/x\nCOMPOSE_FILE=a.yaml\n`,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const raw = await res.text();
    expectNoSecretIn(raw);
    const body = JSON.parse(raw);
    expect(body.skipped).toEqual([
      { name: "COMPOSE_FILE", reason: "reserved" },
    ]);
    const byName = Object.fromEntries(
      body.rows.map((r: { name: string }) => [r.name, r])
    );
    expect(byName.APP_NAME).toMatchObject({ state: "same" });
    expect(byName.DB_PASSWORD).toMatchObject({
      state: "conflict",
      value: null,
    });
    expect(byName.REDIS_URL).toMatchObject({
      state: "new",
      proposedKind: "secret",
      value: null,
    });
    // Never resolved from the deploy shell: flagged, the UI deselects it.
    expect(byName.EXTERNAL).toMatchObject({
      value: "/x",
      flags: { unresolvedRefs: ["HOST_FROM_SHELL"] },
    });
    for (const r of body.rows) expect(r.sources).toBeUndefined();
    expect(serverEnv.readEnvironmentEnvFiles).not.toHaveBeenCalled();
    expect(activity.recordActivity).not.toHaveBeenCalled();
    expectNothingLeaked();
  });

  it("refuses text over 256 KiB, over 1000 entries, or unparsable, without echoing it", async () => {
    const big = `A=${"x".repeat(256 * 1024)}`;
    const tooBig = await send("POST", `${base}/preview`, {
      source: "text",
      text: big,
    });
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toMatchObject({ code: "envTextTooLarge" });

    const many = Array.from({ length: 1001 }, (_, i) => `V${i}=1`).join("\n");
    const tooMany = await send("POST", `${base}/preview`, {
      source: "text",
      text: many,
    });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({
      code: "envTooManyEntries",
      params: { max: 1000 },
    });

    const broken = await send("POST", `${base}/preview`, {
      source: "text",
      text: `OK=1\nBROKEN="${FILE_SECRET}\n`,
    });
    expect(broken.status).toBe(400);
    const brokenBody = await broken.text();
    expect(JSON.parse(brokenBody)).toMatchObject({
      code: "envParseError",
      params: { line: 2 },
    });
    expectNoSecretIn(brokenBody);
  });

  it("caps the request body before parsing it, with a coded 413", async () => {
    const res = await app.request(`${base}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "text",
        text: "\n".repeat(IMPORT_BODY_LIMIT),
      }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: "envTextTooLarge" });
    const save = await app.request(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...SAVE_TEXT,
        text: "x".repeat(IMPORT_BODY_LIMIT + 1),
      }),
    });
    expect(save.status).toBe(413);
    // Refused by the cap itself: the service never ran.
    expect(authz.requireProjectPermission).not.toHaveBeenCalled();
  });
});

describe("POST import (text source)", () => {
  it("re-parses the text and writes the rows; the activity lists names only", async () => {
    const text = `APP_NAME=renamed\nDB_PASSWORD=${FILE_SECRET}\nNEW_FLAG=on\n`;
    const res = await send("POST", base, {
      source: "text",
      text,
      rows: [
        { name: "APP_NAME", kind: "plain" },
        // Downgrading a secret is allowed: the value comes from the text.
        { name: "DB_PASSWORD", kind: "secret" },
        { name: "NEW_FLAG", kind: "plain" },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ imported: 3, overwritten: 2 });
    expect(stored("APP_NAME")).toEqual({
      kind: "plain",
      escrow: false,
      value: "renamed",
    });
    expect(stored("DB_PASSWORD")).toEqual({
      kind: "secret",
      escrow: false,
      value: FILE_SECRET,
    });
    const data = activity.recordActivity.mock.calls[0]?.[0].data;
    expect(data).toEqual({
      environment: "Kestrel Dev",
      source: "text",
      names: "APP_NAME, DB_PASSWORD, NEW_FLAG",
      overwritten: "APP_NAME, DB_PASSWORD",
    });
    expect(JSON.stringify(activity.recordActivity.mock.calls)).not.toContain(
      "renamed"
    );
    expectNothingLeaked();
  });

  it("refuses a row the text does not define (the save trusts no client rows)", async () => {
    const res = await send("POST", base, {
      source: "text",
      text: "NEW_FLAG=on\n",
      rows: [{ name: "OTHER", kind: "plain" }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "importRowUnknown" });
  });

  it("writes all rows or none: an escrow set during the write rolls back", async () => {
    store.escrowDuringWrite = "APP_NAME";
    const res = await send("POST", base, {
      source: "text",
      text: "NEW_FLAG=on\nAPP_NAME=renamed\n",
      rows: [
        { name: "NEW_FLAG", kind: "plain" },
        { name: "APP_NAME", kind: "plain" },
      ],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "variableEscrowed" });
    expect(vars().has("NEW_FLAG")).toBe(false);
    expect(stored("APP_NAME")?.value).toBe("kestrel");
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });
});
