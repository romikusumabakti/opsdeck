import { beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

const state = vi.hoisted(() => ({
  role: "admin" as string,
  rows: [] as Record<string, unknown>[],
  lastSet: null as Record<string, unknown> | null,
  inserted: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("@/lib/authz", async () => {
  const { canOrg } = await import("@/lib/permissions");
  const { HTTPException } = await import("hono/http-exception");
  return {
    requireOrgPermission: vi.fn(async (perms: Parameters<typeof canOrg>[1]) => {
      if (!canOrg(state.role as "admin", perms)) {
        throw new HTTPException(403, { message: "Forbidden" });
      }
      return { user: { id: "user-1", role: state.role } };
    }),
  };
});

const activity = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: activity.record }));

vi.mock("@/lib/db", () => {
  const select = () => ({
    from: () => ({ limit: () => Promise.resolve([...state.rows]) }),
  });
  const insert = () => ({
    values: (values: Record<string, unknown>) => {
      state.inserted = values;
      return {
        returning: async () => [{ id: "acc-1", accessIdpId: null, ...values }],
      };
    },
  });
  const update = () => ({
    set: (values: Record<string, unknown>) => {
      state.lastSet = values;
      return {
        where: () => ({
          returning: async () => [{ ...state.rows[0], ...values }],
        }),
      };
    },
  });
  return { db: { select, insert, update } };
});

const cf = vi.hoisted(() => ({
  verifyAccount: vi.fn(),
  listTunnels: vi.fn(),
}));
vi.mock("@/lib/cloudflare/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cloudflare/api")>()),
  verifyAccount: cf.verifyAccount,
  listTunnels: cf.listTunnels,
}));

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { encryptSecret, decryptSecret } = await import("@/lib/secrets");
const { CloudflareApiError } = await import("@/lib/cloudflare/api");
const { app } = await import("@/server/app");

function row(extra: Record<string, unknown> = {}) {
  return {
    id: "acc-1",
    accountId: ACCOUNT_ID,
    name: "DSS",
    apiToken: encryptSecret("stored-cf-token"),
    accessIdpId: "idp-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  };
}

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.role = "admin";
  state.rows = [row()];
  state.lastSet = null;
  state.inserted = null;
});

describe("permissions", () => {
  it("answers 403 on every route without server:manage", async () => {
    state.role = "engineer";
    const base = "/api/cloudflare-account";
    const body = { accountId: ACCOUNT_ID, name: "x", apiToken: "t" };
    expect((await send("GET", base)).status).toBe(403);
    expect((await send("PUT", base, body)).status).toBe(403);
    expect((await send("POST", `${base}/verify`)).status).toBe(403);
    for (const sub of ["tunnels", "access-policies", "identity-providers"]) {
      expect((await send("GET", `${base}/${sub}`)).status).toBe(403);
    }
    expect(state.lastSet).toBeNull();
    expect(state.inserted).toBeNull();
    expect(cf.verifyAccount).not.toHaveBeenCalled();
  });
});

describe("GET /api/cloudflare-account", () => {
  it("never returns the token, only hasToken", async () => {
    const res = await send("GET", "/api/cloudflare-account");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("stored-cf-token");
    expect(text).not.toContain("enc:v1:");
    const body = JSON.parse(text);
    expect(body).not.toHaveProperty("apiToken");
    expect(body).toMatchObject({ accountId: ACCOUNT_ID, hasToken: true });
  });

  it("answers null before the account is set up", async () => {
    state.rows = [];
    const res = await send("GET", "/api/cloudflare-account");
    expect(await res.json()).toBeNull();
  });
});

describe("PUT /api/cloudflare-account", () => {
  it("a blank token keeps the stored one", async () => {
    const res = await send("PUT", "/api/cloudflare-account", {
      accountId: ACCOUNT_ID,
      name: "Renamed",
      apiToken: "",
    });
    expect(res.status).toBe(200);
    expect(state.lastSet).not.toHaveProperty("apiToken");
    expect(state.lastSet).toHaveProperty("name", "Renamed");
  });

  it("stores a new token encrypted and never echoes it", async () => {
    const res = await send("PUT", "/api/cloudflare-account", {
      accountId: ACCOUNT_ID,
      name: "DSS",
      apiToken: "  brand-new-token ",
    });
    expect(res.status).toBe(200);
    expect(decryptSecret(state.lastSet?.apiToken as string)).toBe(
      "brand-new-token"
    );
    const text = await res.text();
    expect(text).not.toContain("brand-new-token");
    expect(JSON.parse(text).hasToken).toBe(true);
  });

  it("requires a token for the first save", async () => {
    state.rows = [];
    const res = await send("PUT", "/api/cloudflare-account", {
      accountId: ACCOUNT_ID,
      name: "DSS",
    });
    expect(res.status).toBe(400);
    expect(state.inserted).toBeNull();
  });

  it("inserts the first account with an encrypted token", async () => {
    state.rows = [];
    const res = await send("PUT", "/api/cloudflare-account", {
      accountId: ACCOUNT_ID,
      name: "DSS",
      apiToken: "first-token",
    });
    expect(res.status).toBe(200);
    expect(decryptSecret(state.inserted?.apiToken as string)).toBe(
      "first-token"
    );
  });

  it("requires the token again when the account id changes", async () => {
    const res = await send("PUT", "/api/cloudflare-account", {
      accountId: "f".repeat(32),
      name: "DSS",
    });
    expect(res.status).toBe(400);
    expect(state.lastSet).toBeNull();
  });

  it("rejects a malformed account id", async () => {
    const res = await send("PUT", "/api/cloudflare-account", {
      accountId: "nope",
      name: "DSS",
      apiToken: "t",
    });
    expect(res.status).toBe(400);
  });

  it("records the changed field names, never values", async () => {
    await send("PUT", "/api/cloudflare-account", {
      accountId: ACCOUNT_ID,
      name: "DSS",
      apiToken: "secret-in-body",
    });
    expect(activity.record).toHaveBeenCalledTimes(1);
    const entry = activity.record.mock.calls[0]?.[0];
    expect(entry?.action).toBe("cloudflare_account.update");
    expect(entry?.data.fields).toContain("apiToken");
    expect(JSON.stringify(entry)).not.toContain("secret-in-body");
  });
});

describe("Cloudflare-backed routes", () => {
  it("verify decrypts the stored token for the client", async () => {
    cf.verifyAccount.mockResolvedValue({ tunnels: 3 });
    const res = await send("POST", "/api/cloudflare-account/verify");
    expect(await res.json()).toEqual({ tunnels: 3 });
    expect(cf.verifyAccount).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      apiToken: "stored-cf-token",
    });
  });

  it("answers 409 when no account is set up", async () => {
    state.rows = [];
    expect((await send("GET", "/api/cloudflare-account/tunnels")).status).toBe(
      409
    );
  });

  it("passes a Cloudflare error on as 502 without the token", async () => {
    cf.listTunnels.mockRejectedValue(
      new CloudflareApiError("Authentication error (code 10000)")
    );
    const res = await send("GET", "/api/cloudflare-account/tunnels");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("Authentication error");
    expect(text).not.toContain("stored-cf-token");
  });
});
