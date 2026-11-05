import { beforeEach, describe, expect, it, vi } from "vitest";

// The variables API end to end through the Hono app, against an in-memory
// repository. Values really go through lib/secrets, so the tests can check
// what is stored and that no response leaks a decrypted value.

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");

const ENV_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";
const APP_ID = "0197f3a0-1b2c-7def-8000-0123456789d1";
const USER_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";

const SECRET_PLAIN = "s3cr3t-db-password-value";
const GENERATED_PLAIN = "generated-value-0123456789abcdef";
const ESCROW_PLAIN = "escrow-data-encryption-key-xyz";

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
type Template = {
  id: string;
  appId: string;
  name: string;
  kind: Kind;
  required: boolean;
  defaultValue: string | null;
  generatedLength: number | null;
  escrow: boolean;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const state = vi.hoisted(() => ({
  role: "maintainer" as string | null,
  orgRole: "member" as string,
}));

const store = vi.hoisted(() => ({
  env: {
    id: "0197f3a0-1b2c-7def-8000-0123456789e1",
    name: "Sucor Dev",
    slug: "dev",
    host: "192.168.56.129" as string | null,
    url: "https://dev.example.test" as string | null,
    appId: "0197f3a0-1b2c-7def-8000-0123456789d1" as string | null,
    envFileManaged: false,
  },
  tags: ["IMAGE_TAG"] as string[],
  sharedDeployDir: false,
  vars: new Map<string, Row>(),
  templates: [] as Template[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "0197f3a0-1b2c-7def-8000-0123456789a1", role: state.orgRole },
  })),
}));

vi.mock("@/lib/authz", async () => {
  const { canOrg, canProject } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  const session = () => ({
    user: { id: "0197f3a0-1b2c-7def-8000-0123456789a1", role: state.orgRole },
  });
  return {
    requireProjectPermission: vi.fn(
      async (_scope: unknown, perms: Parameters<typeof canProject>[1]) => {
        if (!state.role) throw new HTTPException(404, { message: "Not Found" });
        if (!canProject(state.role as "viewer", perms)) {
          throw new HTTPException(403, { message: "Forbidden" });
        }
        return {
          session: session(),
          role: state.role,
          projectId: "project-1",
        };
      }
    ),
    requireOrgPermission: vi.fn(async (perms: Parameters<typeof canOrg>[1]) => {
      if (!canOrg(state.orgRole, perms)) {
        throw new HTTPException(403, { message: "Forbidden" });
      }
      return session();
    }),
  };
});

const activity = vi.hoisted(() => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/activity", () => activity);

vi.mock("@/lib/variables/repository", () => {
  let seq = 0;
  const id = () => `0197f3a0-1b2c-7def-8000-${String(++seq).padStart(12, "0")}`;
  return {
    getEnvironmentContext: vi.fn(async (environmentId: string) =>
      environmentId === store.env.id ? { ...store.env } : undefined
    ),
    listTagVariableNames: vi.fn(async () => [...store.tags]),
    hasSharedDeployDir: vi.fn(async () => store.sharedDeployDir),
    listVariables: vi.fn(async () =>
      [...store.vars.values()]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((row) => ({
          ...row,
          updatedByName: row.updatedBy ? "Romi" : null,
        }))
    ),
    getVariable: vi.fn(async (_env: string, name: string) =>
      store.vars.get(name)
    ),
    // Mirrors the SQL: the escrow condition is part of the write itself.
    saveVariable: vi.fn(
      async (
        input: Omit<Row, "id" | "createdAt" | "updatedAt">,
        { overwriteEscrowed = false }: { overwriteEscrowed?: boolean } = {}
      ) => {
        const existing = store.vars.get(input.name);
        if (existing?.escrow && !overwriteEscrowed) return false;
        store.vars.set(input.name, {
          id: existing?.id ?? id(),
          createdAt: existing?.createdAt ?? new Date(),
          updatedAt: new Date(),
          ...input,
        });
        return true;
      }
    ),
    replaceGeneratedValue: vi.fn(
      async (input: { name: string; value: string; updatedBy: string }) => {
        const existing = store.vars.get(input.name);
        if (!existing || existing.escrow || existing.kind !== "generated") {
          return false;
        }
        store.vars.set(input.name, {
          ...existing,
          value: input.value,
          updatedBy: input.updatedBy,
          updatedAt: new Date(),
        });
        return true;
      }
    ),
    deleteVariable: vi.fn(async (_env: string, name: string) => {
      const existing = store.vars.get(name);
      if (!existing || existing.escrow) return false;
      store.vars.delete(name);
      return true;
    }),
    insertVariablesIfMissing: vi.fn(
      async (rows: Omit<Row, "id" | "createdAt" | "updatedAt">[]) => {
        const inserted: string[] = [];
        for (const row of rows) {
          if (store.vars.has(row.name)) continue;
          store.vars.set(row.name, {
            ...row,
            id: id(),
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          inserted.push(row.name);
        }
        return inserted;
      }
    ),
    setEnvFileManaged: vi.fn(async (_env: string, enabled: boolean) => {
      store.env.envFileManaged = enabled;
    }),
    getAppIdByKey: vi.fn(async (appKey: string) =>
      appKey === "hris" ? "0197f3a0-1b2c-7def-8000-0123456789d1" : undefined
    ),
    listTemplates: vi.fn(async () => [...store.templates]),
    saveTemplate: vi.fn(
      async (
        appId: string,
        input: Omit<Template, "id" | "appId" | "createdAt" | "updatedAt">
      ) => {
        const index = store.templates.findIndex((t) => t.name === input.name);
        const row: Template = {
          id: index >= 0 ? (store.templates[index] as Template).id : id(),
          appId,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...input,
        };
        if (index >= 0) store.templates[index] = row;
        else store.templates.push(row);
        return row;
      }
    ),
    deleteTemplate: vi.fn(async (_appId: string, name: string) => {
      const before = store.templates.length;
      store.templates = store.templates.filter((t) => t.name !== name);
      return store.templates.length < before;
    }),
  };
});

const { app } = await import("@/server/app");
const repository = await import("@/lib/variables/repository");
const { encryptSecret, decryptSecret } = await import("@/lib/secrets");

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const base = `/api/environments/${ENV_ID}`;

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

function template(
  name: string,
  kind: Kind,
  extra: Partial<Template> = {}
): Template {
  return {
    id: `tpl-${name}`,
    appId: APP_ID,
    name,
    kind,
    required: false,
    defaultValue: null,
    generatedLength: null,
    escrow: false,
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.role = "maintainer";
  state.orgRole = "member";
  store.env.envFileManaged = false;
  store.env.url = "https://dev.example.test";
  store.env.appId = APP_ID;
  store.tags = ["IMAGE_TAG"];
  store.sharedDeployDir = false;
  store.vars = new Map([
    ["APP_NAME", row("APP_NAME", "plain", "hris")],
    ["DB_PASSWORD", row("DB_PASSWORD", "secret", SECRET_PLAIN)],
    ["JWT_SECRET", row("JWT_SECRET", "generated", GENERATED_PLAIN)],
    [
      "DATA_ENCRYPTION_KEY",
      row("DATA_ENCRYPTION_KEY", "generated", ESCROW_PLAIN, true),
    ],
  ]);
  store.templates = [];
});

type Call = { method: string; path: string; body?: unknown };

// Every variable route, as a maintainer would call it successfully.
const VARIABLE_ROUTES: Call[] = [
  { method: "GET", path: `${base}/variables` },
  { method: "GET", path: `${base}/variables?reveal=1` },
  {
    method: "PUT",
    path: `${base}/variables/NEW_VAR`,
    body: { kind: "plain", value: "x" },
  },
  { method: "DELETE", path: `${base}/variables/APP_NAME` },
  { method: "POST", path: `${base}/variables/JWT_SECRET/regenerate` },
  { method: "POST", path: `${base}/variables/apply-template` },
];
const ENV_FILE_ROUTE: Call = {
  method: "PATCH",
  path: `${base}/env-file-managed`,
  body: { enabled: false },
};

describe("permissions", () => {
  it("a maintainer may use every route", async () => {
    for (const call of [...VARIABLE_ROUTES, ENV_FILE_ROUTE]) {
      const res = await send(call.method, call.path, call.body);
      expect(res.status, `${call.method} ${call.path}`).toBe(200);
    }
  });

  it("a contributor gets 403 everywhere", async () => {
    state.role = "contributor";
    const before = JSON.stringify([...store.vars.entries()]);
    for (const call of [...VARIABLE_ROUTES, ENV_FILE_ROUTE]) {
      const res = await send(call.method, call.path, call.body);
      expect(res.status, `${call.method} ${call.path}`).toBe(403);
    }
    expect(JSON.stringify([...store.vars.entries()])).toBe(before);
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("a viewer gets 403", async () => {
    state.role = "viewer";
    const res = await send("GET", `${base}/variables`);
    expect(res.status).toBe(403);
  });

  it("template routes need integration:manage", async () => {
    const calls: Call[] = [
      { method: "GET", path: "/api/apps/hris/variable-templates" },
      {
        method: "PUT",
        path: "/api/apps/hris/variable-templates/APP_URL",
        body: { kind: "plain", defaultValue: "{url}" },
      },
      { method: "DELETE", path: "/api/apps/hris/variable-templates/APP_URL" },
    ];
    for (const call of calls) {
      const res = await send(call.method, call.path, call.body);
      expect(res.status, `${call.method} ${call.path}`).toBe(403);
    }
    state.orgRole = "admin";
    for (const call of calls) {
      const res = await send(call.method, call.path, call.body);
      expect(res.status, `${call.method} ${call.path}`).toBe(200);
    }
  });
});

describe("listing", () => {
  it("masks secret and generated values, shows plain ones", async () => {
    const res = await send("GET", `${base}/variables`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      envFileManaged: boolean;
      variables: {
        name: string;
        kind: string;
        value: string | null;
        hasValue: boolean;
        escrow: boolean;
      }[];
    };
    const byName = new Map(body.variables.map((v) => [v.name, v]));
    expect(byName.get("APP_NAME")).toMatchObject({
      kind: "plain",
      value: "hris",
      hasValue: true,
    });
    expect(byName.get("DB_PASSWORD")).toMatchObject({
      kind: "secret",
      value: null,
      hasValue: true,
    });
    expect(byName.get("JWT_SECRET")).toMatchObject({
      value: null,
      hasValue: true,
    });
    expect(byName.get("DATA_ENCRYPTION_KEY")).toMatchObject({ escrow: true });
    expect(body.envFileManaged).toBe(false);
    expect(activity.recordActivity).not.toHaveBeenCalled();
  });

  it("never sends the stored ciphertext either", async () => {
    const text = await (await send("GET", `${base}/variables`)).text();
    expect(text).not.toContain("enc:v1:");
  });

  it("reveal=1 returns decrypted values and records one activity entry without values", async () => {
    const res = await send("GET", `${base}/variables?reveal=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      variables: { name: string; value: string | null }[];
    };
    const byName = new Map(body.variables.map((v) => [v.name, v.value]));
    expect(byName.get("DB_PASSWORD")).toBe(SECRET_PLAIN);
    expect(byName.get("JWT_SECRET")).toBe(GENERATED_PLAIN);
    expect(byName.get("APP_NAME")).toBe("hris");

    expect(activity.recordActivity).toHaveBeenCalledTimes(1);
    const entry = activity.recordActivity.mock.calls[0]?.[0];
    expect(entry).toMatchObject({
      actorId: USER_ID,
      action: "variables.revealed",
      entityType: "environment",
      entityId: ENV_ID,
    });
    expect(String(entry.data.names)).toContain("DB_PASSWORD");
    const logged = JSON.stringify(entry);
    for (const secret of [SECRET_PLAIN, GENERATED_PLAIN, ESCROW_PLAIN]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("answers 404 for an environment the caller cannot see", async () => {
    state.role = null;
    expect((await send("GET", `${base}/variables`)).status).toBe(404);
  });
});

describe("writing", () => {
  it("encrypts a secret, records updatedBy and answers masked", async () => {
    const res = await send("PUT", `${base}/variables/API_KEY`, {
      kind: "secret",
      value: "brand-new-api-key-123",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("brand-new-api-key-123");
    const stored = store.vars.get("API_KEY");
    expect(stored?.value.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(stored?.value ?? "")).toBe("brand-new-api-key-123");
    expect(stored?.updatedBy).toBe(USER_ID);
  });

  it("stores a plain value as text", async () => {
    await send("PUT", `${base}/variables/APP_URL`, {
      kind: "plain",
      value: "https://a#b c=$d",
    });
    expect(store.vars.get("APP_URL")?.value).toBe("https://a#b c=$d");
  });

  it("generates a generated value with the template's length, or 32", async () => {
    store.templates = [
      template("SESSION_KEY", "generated", { generatedLength: 48 }),
    ];
    const res = await send("PUT", `${base}/variables/SESSION_KEY`, {
      kind: "generated",
    });
    expect(res.status).toBe(200);
    expect(
      decryptSecret(store.vars.get("SESSION_KEY")?.value ?? "")
    ).toHaveLength(48);

    await send("PUT", `${base}/variables/OTHER_KEY`, { kind: "generated" });
    expect(decryptSecret(store.vars.get("OTHER_KEY")?.value ?? "")).toMatch(
      /^[A-Za-z0-9_-]{32}$/
    );
  });

  it("keeps the stored value when an existing variable is saved without one", async () => {
    const res = await send("PUT", `${base}/variables/JWT_SECRET`, {
      kind: "generated",
      escrow: true,
    });
    expect(res.status).toBe(200);
    const stored = store.vars.get("JWT_SECRET");
    expect(decryptSecret(stored?.value ?? "")).toBe(GENERATED_PLAIN);
    expect(stored?.escrow).toBe(true);
  });

  it("refuses turning a secret or generated variable plain without a value", async () => {
    for (const name of ["DB_PASSWORD", "JWT_SECRET"]) {
      const before = store.vars.get(name);
      const res = await send("PUT", `${base}/variables/${name}`, {
        kind: "plain",
      });
      expect(res.status, name).toBe(400);
      const text = await res.text();
      expect(text).not.toContain(SECRET_PLAIN);
      expect(text).not.toContain(GENERATED_PLAIN);
      expect(store.vars.get(name)).toEqual(before);
    }
  });

  it("turns a secret plain with an explicit value", async () => {
    const res = await send("PUT", `${base}/variables/DB_PASSWORD`, {
      kind: "plain",
      value: "now-public",
    });
    expect(res.status).toBe(200);
    expect(store.vars.get("DB_PASSWORD")).toMatchObject({
      kind: "plain",
      value: "now-public",
    });
  });

  it("requires a value for a new plain or secret variable", async () => {
    const res = await send("PUT", `${base}/variables/NEW_SECRET`, {
      kind: "secret",
    });
    expect(res.status).toBe(400);
    expect(store.vars.has("NEW_SECRET")).toBe(false);
  });

  it("rejects a value with a line break", async () => {
    const res = await send("PUT", `${base}/variables/MULTI`, {
      kind: "plain",
      value: "a\nb",
    });
    expect(res.status).toBe(400);
    expect(store.vars.has("MULTI")).toBe(false);
  });

  it("rejects an invalid name and a tag variable's name", async () => {
    expect(
      (
        await send("PUT", `${base}/variables/lower_case`, {
          kind: "plain",
          value: "x",
        })
      ).status
    ).toBe(400);
    const res = await send("PUT", `${base}/variables/IMAGE_TAG`, {
      kind: "plain",
      value: "x",
    });
    expect(res.status).toBe(400);
    expect(store.vars.has("IMAGE_TAG")).toBe(false);
  });

  it("deletes a variable", async () => {
    const res = await send("DELETE", `${base}/variables/APP_NAME`);
    expect(res.status).toBe(200);
    expect(store.vars.has("APP_NAME")).toBe(false);
  });

  it("answers 404 for an unknown variable", async () => {
    expect((await send("DELETE", `${base}/variables/NOPE`)).status).toBe(404);
    expect(
      (await send("POST", `${base}/variables/NOPE/regenerate`)).status
    ).toBe(404);
  });

  it("regenerates a generated variable only", async () => {
    const res = await send("POST", `${base}/variables/JWT_SECRET/regenerate`);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(GENERATED_PLAIN);
    const value = decryptSecret(store.vars.get("JWT_SECRET")?.value ?? "");
    expect(value).not.toBe(GENERATED_PLAIN);
    expect(value).toHaveLength(32);

    expect(
      (await send("POST", `${base}/variables/DB_PASSWORD/regenerate`)).status
    ).toBe(409);
  });
});

describe("escrow", () => {
  it("refuses delete and regenerate of an escrowed variable", async () => {
    expect(
      (await send("DELETE", `${base}/variables/DATA_ENCRYPTION_KEY`)).status
    ).toBe(409);
    expect(
      (await send("POST", `${base}/variables/DATA_ENCRYPTION_KEY/regenerate`))
        .status
    ).toBe(409);
    expect(
      decryptSecret(store.vars.get("DATA_ENCRYPTION_KEY")?.value ?? "")
    ).toBe(ESCROW_PLAIN);
  });

  it("refuses changing an escrowed value", async () => {
    const res = await send("PUT", `${base}/variables/DATA_ENCRYPTION_KEY`, {
      kind: "generated",
      value: "replacement-value",
    });
    expect(res.status).toBe(409);
    expect(
      decryptSecret(store.vars.get("DATA_ENCRYPTION_KEY")?.value ?? "")
    ).toBe(ESCROW_PLAIN);
  });

  it("refuses clearing escrow without the explicit flag", async () => {
    const res = await send("PUT", `${base}/variables/DATA_ENCRYPTION_KEY`, {
      kind: "generated",
      escrow: false,
    });
    expect(res.status).toBe(409);
    expect(store.vars.get("DATA_ENCRYPTION_KEY")?.escrow).toBe(true);
  });

  it("lets only an admin with integration:manage clear escrow explicitly", async () => {
    const body = {
      kind: "generated",
      escrow: false,
      confirmEscrowRemoval: true,
    };
    expect(
      (await send("PUT", `${base}/variables/DATA_ENCRYPTION_KEY`, body)).status
    ).toBe(403);
    expect(store.vars.get("DATA_ENCRYPTION_KEY")?.escrow).toBe(true);

    state.orgRole = "admin";
    expect(
      (await send("PUT", `${base}/variables/DATA_ENCRYPTION_KEY`, body)).status
    ).toBe(200);
    const stored = store.vars.get("DATA_ENCRYPTION_KEY");
    expect(stored?.escrow).toBe(false);
    expect(decryptSecret(stored?.value ?? "")).toBe(ESCROW_PLAIN);
  });

  // The row became escrowed between the service's read and its write: the
  // write itself must refuse (the read is simulated stale).
  describe("escrow set concurrently", () => {
    beforeEach(() => {
      store.vars.set("JWT_SECRET", {
        ...(store.vars.get("JWT_SECRET") as Row),
        escrow: true,
      });
      vi.mocked(repository.getVariable).mockImplementationOnce(
        async (_env: string, name: string) => {
          const row = store.vars.get(name);
          return row && { ...row, escrow: false };
        }
      );
    });

    it("delete answers 409 and keeps the row", async () => {
      expect(
        (await send("DELETE", `${base}/variables/JWT_SECRET`)).status
      ).toBe(409);
      expect(store.vars.has("JWT_SECRET")).toBe(true);
    });

    it("regenerate answers 409, keeps the value and never clears escrow", async () => {
      expect(
        (await send("POST", `${base}/variables/JWT_SECRET/regenerate`)).status
      ).toBe(409);
      const row = store.vars.get("JWT_SECRET");
      expect(row?.escrow).toBe(true);
      expect(decryptSecret(row?.value ?? "")).toBe(GENERATED_PLAIN);
      expect(repository.saveVariable).not.toHaveBeenCalled();
    });

    it("put answers 409 and keeps the value", async () => {
      expect(
        (
          await send("PUT", `${base}/variables/JWT_SECRET`, {
            kind: "generated",
            value: "overwrite-attempt",
          })
        ).status
      ).toBe(409);
      expect(decryptSecret(store.vars.get("JWT_SECRET")?.value ?? "")).toBe(
        GENERATED_PLAIN
      );
    });
  });

  it("keeps escrow when the flag is omitted", async () => {
    const res = await send("PUT", `${base}/variables/DATA_ENCRYPTION_KEY`, {
      kind: "generated",
    });
    expect(res.status).toBe(200);
    expect(store.vars.get("DATA_ENCRYPTION_KEY")?.escrow).toBe(true);
  });
});

describe("apply-template", () => {
  beforeEach(() => {
    store.vars = new Map([["APP_NAME", row("APP_NAME", "plain", "keep-me")]]);
    store.templates = [
      template("APP_NAME", "plain", { defaultValue: "overwritten?" }),
      template("APP_URL", "plain", {
        defaultValue: "{url}/api?env={envSlug}",
        required: true,
      }),
      template("SESSION_KEY", "generated", {
        generatedLength: 64,
        escrow: true,
      }),
      template("DB_PASSWORD", "secret", { required: true }),
      template("SMTP_HOST", "plain", { required: true }),
      template("OPTIONAL_SECRET", "secret"),
    ];
  });

  it("fills missing variables and lists required ones it could not fill", async () => {
    const res = await send("POST", `${base}/variables/apply-template`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { added: string[]; missing: string[] };
    expect(body.added.sort()).toEqual(["APP_URL", "SESSION_KEY"]);
    expect(body.missing.sort()).toEqual(["DB_PASSWORD", "SMTP_HOST"]);

    expect(store.vars.get("APP_NAME")?.value).toBe("keep-me");
    expect(store.vars.get("APP_URL")?.value).toBe(
      "https://dev.example.test/api?env=dev"
    );
    const session = store.vars.get("SESSION_KEY");
    expect(session?.escrow).toBe(true);
    expect(session?.kind).toBe("generated");
    expect(decryptSecret(session?.value ?? "")).toHaveLength(64);
    expect(session?.updatedBy).toBe(USER_ID);
    expect(JSON.stringify(body)).not.toContain(
      decryptSecret(session?.value ?? "")
    );
  });

  it("lists a required default whose placeholder has no value as missing", async () => {
    store.env.url = null;
    const res = await send("POST", `${base}/variables/apply-template`);
    const body = (await res.json()) as { added: string[]; missing: string[] };
    expect(body.missing).toContain("APP_URL");
    expect(store.vars.has("APP_URL")).toBe(false);
  });

  it("answers 409 when the environment has no app", async () => {
    store.env.appId = null;
    expect(
      (await send("POST", `${base}/variables/apply-template`)).status
    ).toBe(409);
  });
});

describe("env-file-managed", () => {
  beforeEach(() => {
    store.templates = [
      template("DB_PASSWORD", "secret", { required: true }),
      template("SMTP_HOST", "plain", { required: true }),
      template("OPTIONAL", "plain"),
    ];
  });

  it("refuses turning it on while a required variable is missing", async () => {
    const res = await send("PATCH", `${base}/env-file-managed`, {
      enabled: true,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(
      "SMTP_HOST"
    );
    expect(store.env.envFileManaged).toBe(false);
  });

  it("turns it on once every required variable exists, and off again", async () => {
    store.vars.set("SMTP_HOST", row("SMTP_HOST", "plain", "mail"));
    const on = await send("PATCH", `${base}/env-file-managed`, {
      enabled: true,
    });
    expect(on.status).toBe(200);
    expect(store.env.envFileManaged).toBe(true);
    const off = await send("PATCH", `${base}/env-file-managed`, {
      enabled: false,
    });
    expect(off.status).toBe(200);
    expect(store.env.envFileManaged).toBe(false);
  });

  it("refuses turning it on when another environment deploys into the same dir", async () => {
    store.vars.set("SMTP_HOST", row("SMTP_HOST", "plain", "mail"));
    store.sharedDeployDir = true;
    const res = await send("PATCH", `${base}/env-file-managed`, {
      enabled: true,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Another environment deploys into this directory"
    );
    expect(store.env.envFileManaged).toBe(false);
  });

  it("turning it off is allowed even when the dir is shared", async () => {
    store.env.envFileManaged = true;
    store.sharedDeployDir = true;
    const res = await send("PATCH", `${base}/env-file-managed`, {
      enabled: false,
    });
    expect(res.status).toBe(200);
    expect(store.env.envFileManaged).toBe(false);
  });
});

describe("templates", () => {
  beforeEach(() => {
    state.orgRole = "admin";
  });

  const put = (name: string, body: unknown) =>
    send("PUT", `/api/apps/hris/variable-templates/${name}`, body);

  it("saves and lists a template", async () => {
    expect(
      (
        await put("APP_URL", {
          kind: "plain",
          required: true,
          defaultValue: "{url}",
          description: "Public URL",
        })
      ).status
    ).toBe(200);
    expect(
      (await put("SESSION_KEY", { kind: "generated", generatedLength: 64 }))
        .status
    ).toBe(200);
    const res = await send("GET", "/api/apps/hris/variable-templates");
    const list = (await res.json()) as { name: string }[];
    expect(list.map((t) => t.name).sort()).toEqual(["APP_URL", "SESSION_KEY"]);
  });

  it("enforces kind consistency", async () => {
    expect((await put("A", { kind: "secret", defaultValue: "x" })).status).toBe(
      400
    );
    expect(
      (await put("B", { kind: "secret", generatedLength: 32 })).status
    ).toBe(400);
    expect(
      (await put("C", { kind: "plain", generatedLength: 32 })).status
    ).toBe(400);
    expect(
      (await put("D", { kind: "generated", defaultValue: "x" })).status
    ).toBe(400);
    expect(
      (await put("E", { kind: "generated", generatedLength: 8 })).status
    ).toBe(400);
    expect(
      (await put("F", { kind: "generated", generatedLength: 129 })).status
    ).toBe(400);
    expect(
      (await put("G", { kind: "plain", defaultValue: "a\nb" })).status
    ).toBe(400);
    expect((await put("lower", { kind: "plain" })).status).toBe(400);
    expect(store.templates).toHaveLength(0);
  });

  it("answers 404 for an unknown app or template", async () => {
    expect(
      (await send("GET", "/api/apps/nope/variable-templates")).status
    ).toBe(404);
    expect(
      (await send("DELETE", "/api/apps/hris/variable-templates/NOPE")).status
    ).toBe(404);
  });
});

describe("no decrypted value without reveal", () => {
  it("holds across every non-reveal response", async () => {
    store.templates = [template("SESSION_KEY", "generated")];
    const calls: Call[] = [
      { method: "GET", path: `${base}/variables` },
      {
        method: "PUT",
        path: `${base}/variables/DB_PASSWORD`,
        body: { kind: "secret", value: SECRET_PLAIN },
      },
      {
        method: "PUT",
        path: `${base}/variables/JWT_SECRET`,
        body: { kind: "generated" },
      },
      // Turning a secret plain without a value must not answer it in clear.
      {
        method: "PUT",
        path: `${base}/variables/DB_PASSWORD`,
        body: { kind: "plain" },
      },
      {
        method: "PUT",
        path: `${base}/variables/JWT_SECRET`,
        body: { kind: "plain" },
      },
      { method: "POST", path: `${base}/variables/apply-template` },
      { method: "GET", path: `${base}/variables` },
    ];
    const bodies: string[] = [];
    for (const call of calls) {
      bodies.push(await (await send(call.method, call.path, call.body)).text());
    }
    const regenerated = await send(
      "POST",
      `${base}/variables/JWT_SECRET/regenerate`
    );
    bodies.push(await regenerated.text());

    const secrets = [...store.vars.values()]
      .filter((v) => v.kind !== "plain")
      .map((v) => decryptSecret(v.value));
    secrets.push(SECRET_PLAIN, GENERATED_PLAIN, ESCROW_PLAIN);
    for (const body of bodies) {
      for (const secret of secrets) expect(body).not.toContain(secret);
      expect(body).not.toContain("enc:v1:");
    }
  });
});
