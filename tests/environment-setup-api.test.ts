import { beforeEach, describe, expect, it, vi } from "vitest";

// The setup wizard's environment API without a database: who may call it,
// and the variable copy rules (planEnvironmentVariables). The full create and
// preview against a real Panel database are in
// tests/environment-setup-scratch.test.ts.

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");

const PROJECT_ID = "0197f3a0-1b2c-7def-8000-0123456789f1";
const APP_ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const SERVER_ID = "0197f3a0-1b2c-7def-8000-0123456789c1";
const SOURCE_ID = "0197f3a0-1b2c-7def-8000-0123456789e1";

const state = vi.hoisted(() => ({
  // Role in the target project, and in the copy source's; null = invisible.
  projectRole: "maintainer" as string | null,
  sourceRole: "maintainer" as string | null,
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: async () => null }, handler: vi.fn() },
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("@/lib/authz", async () => {
  const { canProject } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    requireProjectPermission: vi.fn(
      async (
        scope: { projectId?: string; environmentId?: string },
        perms: Parameters<typeof canProject>[1]
      ) => {
        const role = scope.projectId ? state.projectRole : state.sourceRole;
        if (!role) throw new HTTPException(404, { message: "Not Found" });
        if (!canProject(role as "viewer", perms)) {
          throw new HTTPException(403, { message: "Forbidden" });
        }
        return {
          session: { user: { id: "user-1", role: "member" } },
          role,
          projectId: PROJECT_ID,
        };
      }
    ),
  };
});

// Any query fails the test: the refusals below happen before the database.
const dbCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/db", () => {
  const touch = () => {
    dbCalls.count++;
    throw new Error("unexpected database access");
  };
  return {
    db: { select: touch, insert: touch, update: touch, transaction: touch },
  };
});

const { app } = await import("@/server/app");
const { planEnvironmentVariables } = await import(
  "@/server/services/variables"
);
const { decryptSecret, encryptSecret } = await import("@/lib/secrets");

const input = {
  projectId: PROJECT_ID,
  appId: APP_ID,
  name: "Staging",
  server: { serverId: SERVER_ID },
  targets: [
    {
      componentKey: "hris",
      sourceBranch: "main",
      deployDir: "/deployments/hris-staging",
      services: ["hris-backend"],
    },
  ],
  database: { kind: "none" },
  variables: [],
  domain: { kind: "none" },
};

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.projectRole = "maintainer";
  state.sourceRole = "maintainer";
  dbCalls.count = 0;
});

describe("environment setup permissions", () => {
  for (const role of ["contributor", "viewer"]) {
    it(`refuses a ${role} (QA) with 403 on create and preview`, async () => {
      state.projectRole = role;
      for (const path of [
        "/api/setup/environments",
        "/api/setup/environments/preview",
      ]) {
        const res = await post(path, input);
        expect(res.status, path).toBe(403);
      }
      expect(dbCalls.count).toBe(0);
    });
  }

  it("answers 404 for a project the caller cannot see", async () => {
    state.projectRole = null;
    const res = await post("/api/setup/environments", input);
    expect(res.status).toBe(404);
  });

  it("answers 404 when the copy source is invisible", async () => {
    state.sourceRole = null;
    const res = await post("/api/setup/environments/preview", {
      ...input,
      copyFromEnvironmentId: SOURCE_ID,
    });
    expect(res.status).toBe(404);
    expect(dbCalls.count).toBe(0);
  });

  it("answers 404 for copy-source of an invisible environment", async () => {
    state.sourceRole = null;
    const res = await app.request(
      `/api/setup/environments/copy-source/${SOURCE_ID}`
    );
    expect(res.status).toBe(404);
    expect(dbCalls.count).toBe(0);
  });

  it("refuses a malformed setup with the generic 400", async () => {
    const res = await post("/api/setup/environments", {
      ...input,
      targets: [],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request" });
  });
});

type Template = Parameters<
  typeof planEnvironmentVariables
>[0]["templates"][number];

function template(overrides: Partial<Template> & { name: string }): Template {
  return {
    id: `t-${overrides.name}`,
    appId: APP_ID,
    kind: "plain",
    required: false,
    defaultValue: null,
    generatedLength: null,
    escrow: false,
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("planEnvironmentVariables", () => {
  const SOURCE_SECRET = "source-smtp-password";
  const SOURCE_KEY = "source-data-encryption-key";
  const SOURCE_DB_PASSWORD = "source-db-password-0123456789";
  const source = [
    { name: "APP_NAME", kind: "plain", value: "HRIS", escrow: false },
    {
      name: "SMTP_PASSWORD",
      kind: "secret",
      value: encryptSecret(SOURCE_SECRET),
      escrow: false,
    },
    {
      name: "DATA_ENCRYPTION_KEY",
      kind: "secret",
      value: encryptSecret(SOURCE_KEY),
      escrow: true,
    },
    {
      name: "DB_PASSWORD",
      kind: "generated",
      value: encryptSecret(SOURCE_DB_PASSWORD),
      escrow: false,
    },
  ] as const;
  const base = {
    templates: [],
    source: [...source],
    canReadSource: true,
    tagNames: ["IMAGE_TAG"],
    placeholders: {
      host: null,
      url: "https://hris-staging.example.com",
      envSlug: "staging",
    },
  };

  it("copies a plain value and a secret's ciphertext for a reader", () => {
    const { variables, issues } = planEnvironmentVariables({
      ...base,
      entries: [
        { name: "APP_NAME", kind: "plain", copy: true },
        { name: "SMTP_PASSWORD", kind: "secret", copy: true },
      ],
    });
    expect(issues).toEqual([]);
    expect(variables).toEqual([
      expect.objectContaining({
        name: "APP_NAME",
        value: "HRIS",
        origin: "copied",
      }),
      expect.objectContaining({
        name: "SMTP_PASSWORD",
        value: source[1].value,
        origin: "copied",
      }),
    ]);
    expect(decryptSecret(variables[1]?.value ?? "")).toBe(SOURCE_SECRET);
  });

  it("leaves a secret blank for a caller who may not read the source", () => {
    const { variables, issues } = planEnvironmentVariables({
      ...base,
      canReadSource: false,
      entries: [
        { name: "SMTP_PASSWORD", kind: "secret", copy: true },
        { name: "APP_NAME", kind: "plain", copy: true },
      ],
    });
    expect(variables).toEqual([]);
    expect(issues).toEqual([
      { name: "SMTP_PASSWORD", code: "secretCopyForbidden" },
      { name: "APP_NAME", code: "copyForbidden" },
    ]);
  });

  it("generates generated values anew, never the source's", () => {
    const { variables, issues } = planEnvironmentVariables({
      ...base,
      templates: [
        template({
          name: "DB_PASSWORD",
          kind: "generated",
          generatedLength: 48,
        }),
      ],
      entries: [{ name: "DB_PASSWORD", kind: "generated", copy: true }],
    });
    expect(issues).toEqual([]);
    const value = decryptSecret(variables[0]?.value ?? "");
    expect(variables[0]?.origin).toBe("generated");
    expect(value).toHaveLength(48);
    expect(value).not.toBe(SOURCE_DB_PASSWORD);
  });

  it("never copies an escrowed secret; it needs a value and stays escrowed", () => {
    const refused = planEnvironmentVariables({
      ...base,
      entries: [{ name: "DATA_ENCRYPTION_KEY", kind: "secret", copy: true }],
    });
    expect(refused.variables).toEqual([]);
    expect(refused.issues).toEqual([
      { name: "DATA_ENCRYPTION_KEY", code: "escrowCopyForbidden" },
    ]);

    const entered = planEnvironmentVariables({
      ...base,
      entries: [
        { name: "DATA_ENCRYPTION_KEY", kind: "secret", value: "new-key" },
      ],
    });
    expect(entered.issues).toEqual([]);
    expect(entered.variables[0]?.escrow).toBe(true);
    expect(decryptSecret(entered.variables[0]?.value ?? "")).toBe("new-key");
  });

  it("regenerates an escrowed generated template variable", () => {
    const { variables } = planEnvironmentVariables({
      ...base,
      templates: [
        template({
          name: "SIGNING_KEY",
          kind: "generated",
          escrow: true,
          generatedLength: 64,
        }),
      ],
      entries: [{ name: "SIGNING_KEY", kind: "generated", copy: true }],
    });
    expect(variables[0]).toMatchObject({ escrow: true, origin: "generated" });
    expect(decryptSecret(variables[0]?.value ?? "")).toHaveLength(64);
  });

  it("refuses a copy across kinds, so a secret is never stored as plain", () => {
    const { issues } = planEnvironmentVariables({
      ...base,
      entries: [{ name: "SMTP_PASSWORD", kind: "plain", copy: true }],
    });
    expect(issues).toEqual([
      { name: "SMTP_PASSWORD", code: "copyKindMismatch" },
    ]);
  });

  it("needs a source to copy from and the variable there", () => {
    expect(
      planEnvironmentVariables({
        ...base,
        source: null,
        entries: [{ name: "APP_NAME", kind: "plain", copy: true }],
      }).issues
    ).toEqual([{ name: "APP_NAME", code: "copySourceRequired" }]);
    expect(
      planEnvironmentVariables({
        ...base,
        entries: [{ name: "MISSING", kind: "secret", copy: true }],
      }).issues
    ).toEqual([{ name: "MISSING", code: "copySourceMissing" }]);
  });

  it("applies the variables rules to names and values", () => {
    const { issues } = planEnvironmentVariables({
      ...base,
      entries: [
        { name: "COMPOSE_FILE", kind: "plain", value: "x" },
        { name: "IMAGE_TAG", kind: "plain", value: "x" },
        { name: "lower", kind: "plain", value: "x" },
        { name: "A", kind: "plain", value: "x" },
        { name: "A", kind: "plain", value: "y" },
        { name: "B", kind: "plain", value: "two\nlines" },
        { name: "C", kind: "secret" },
      ],
    });
    expect(issues).toEqual([
      { name: "COMPOSE_FILE", code: "reservedPrefix" },
      { name: "IMAGE_TAG", code: "tagVariableName" },
      { name: "lower", code: "variableNameInvalid" },
      { name: "A", code: "variableDuplicate" },
      { name: "B", code: "valueInvalid" },
      { name: "C", code: "valueRequired" },
    ]);
  });

  it("fills the template's other variables and reports missing required ones", () => {
    const { variables, issues } = planEnvironmentVariables({
      ...base,
      templates: [
        template({ name: "CORS_ORIGINS", defaultValue: "{url}" }),
        template({ name: "SESSION_SECRET", kind: "generated" }),
        template({ name: "SMTP_PASSWORD", kind: "secret", required: true }),
        template({ name: "IMAGE_TAG", kind: "plain", defaultValue: "x" }),
      ],
      entries: [],
    });
    expect(variables.map((v) => [v.name, v.origin])).toEqual([
      ["CORS_ORIGINS", "template"],
      ["SESSION_SECRET", "template"],
    ]);
    expect(variables[0]?.value).toBe("https://hris-staging.example.com");
    expect(decryptSecret(variables[1]?.value ?? "")).toHaveLength(32);
    expect(issues).toEqual([
      { name: "SMTP_PASSWORD", code: "variableRequired" },
    ]);
  });
});
