import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "0197f3a0-1b2c-7def-8000-0123456789a1";

const state = vi.hoisted(() => ({
  role: "admin" as string,
  rows: [] as Record<string, unknown>[],
  lastSet: null as Record<string, unknown> | null,
  updateError: null as Error | null,
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

// A single-table fake: the predicate is ignored, so a test chooses "found" or
// "missing" through state.rows.
vi.mock("@/lib/db", () => {
  const select = () => ({
    from: () => {
      const rows = () => Promise.resolve([...state.rows]);
      return Object.assign(rows(), {
        orderBy: rows,
        where: () => ({ limit: rows }),
      });
    },
  });
  const update = () => ({
    set: (values: Record<string, unknown>) => {
      state.lastSet = values;
      return {
        where: () => ({
          returning: async () => {
            if (state.updateError) throw state.updateError;
            if (state.rows.length === 0) return [];
            state.rows[0] = { ...state.rows[0], ...values };
            return [state.rows[0]];
          },
        }),
      };
    },
  });
  return { db: { select, update } };
});

const woodpecker = vi.hoisted(() => ({
  create: vi.fn(),
}));
vi.mock("@/lib/ci/woodpecker", () => ({
  createWoodpeckerProvider: woodpecker.create,
}));

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { encryptSecret, decryptSecret } = await import("@/lib/secrets");
const { app } = await import("@/server/app");
const { getProviderForConnection } = await import(
  "@/server/services/ci-connections"
);

function row(extra: Record<string, unknown> = {}) {
  return {
    id: ID,
    name: "Woodpecker - Bitbucket",
    provider: "woodpecker",
    forge: "bitbucket",
    baseUrl: "https://ci.example.test",
    apiToken: encryptSecret("wp-secret-token"),
    forgeUsername: "ci-bot",
    forgeToken: encryptSecret("forge-secret-token"),
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
  vi.resetAllMocks();
  state.role = "admin";
  state.rows = [row()];
  state.lastSet = null;
  state.updateError = null;
  woodpecker.create.mockReturnValue({});
});

describe("permissions", () => {
  it("a non-admin gets 403 on list and patch", async () => {
    state.role = "member";
    expect((await send("GET", "/api/ci-connections")).status).toBe(403);
    expect(
      (await send("PATCH", `/api/ci-connections/${ID}`, { name: "x" })).status
    ).toBe(403);
    expect(woodpecker.create).not.toHaveBeenCalled();
    expect(state.lastSet).toBeNull();
  });
});

describe("GET /api/ci-connections", () => {
  it("never returns credential values", async () => {
    const res = await send("GET", "/api/ci-connections");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("wp-secret-token");
    expect(text).not.toContain("forge-secret-token");
    expect(text).not.toContain("enc:v1:");
    const [item] = JSON.parse(text);
    expect(item).not.toHaveProperty("apiToken");
    expect(item).not.toHaveProperty("forgeToken");
    expect(item).toMatchObject({
      id: ID,
      hasApiToken: true,
      hasForgeToken: true,
      forgeUsername: "ci-bot",
    });
  });

  it("reports missing tokens as false", async () => {
    state.rows = [row({ apiToken: null, forgeToken: null })];
    const [item] = await (await send("GET", "/api/ci-connections")).json();
    expect(item).toMatchObject({ hasApiToken: false, hasForgeToken: false });
  });
});

describe("PATCH /api/ci-connections/:id", () => {
  it("an empty apiToken clears it", async () => {
    const res = await send("PATCH", `/api/ci-connections/${ID}`, {
      apiToken: "",
    });
    expect(res.status).toBe(200);
    expect(state.lastSet).toHaveProperty("apiToken", null);
    expect(state.lastSet).not.toHaveProperty("forgeToken");
  });

  it("an absent apiToken keeps the stored one", async () => {
    const res = await send("PATCH", `/api/ci-connections/${ID}`, {
      name: "Renamed",
    });
    expect(res.status).toBe(200);
    expect(state.lastSet).not.toHaveProperty("apiToken");
    expect(state.lastSet).toHaveProperty("name", "Renamed");
  });

  it("a new token is stored encrypted and never echoed", async () => {
    const res = await send("PATCH", `/api/ci-connections/${ID}`, {
      forgeToken: "brand-new-forge-token",
      baseUrl: "https://ci.example.test/",
    });
    expect(res.status).toBe(200);
    const stored = state.lastSet?.forgeToken as string;
    expect(stored).not.toBe("brand-new-forge-token");
    expect(decryptSecret(stored)).toBe("brand-new-forge-token");
    expect(state.lastSet?.baseUrl).toBe("https://ci.example.test");
    expect(await res.text()).not.toContain("brand-new-forge-token");
  });

  it("clears forgeUsername with an empty string", async () => {
    await send("PATCH", `/api/ci-connections/${ID}`, { forgeUsername: "" });
    expect(state.lastSet).toHaveProperty("forgeUsername", null);
  });

  it("rejects a whitespace-only token with 400 and trims others", async () => {
    const bad = await send("PATCH", `/api/ci-connections/${ID}`, {
      apiToken: "   ",
    });
    expect(bad.status).toBe(400);
    expect(state.lastSet).toBeNull();
    await send("PATCH", `/api/ci-connections/${ID}`, {
      forgeToken: "  padded  ",
      forgeUsername: "  bot ",
    });
    expect(decryptSecret(state.lastSet?.forgeToken as string)).toBe("padded");
    expect(state.lastSet?.forgeUsername).toBe("bot");
  });

  it("requires a new token when the URL changes", async () => {
    const res = await send("PATCH", `/api/ci-connections/${ID}`, {
      baseUrl: "https://other.example.test",
    });
    expect(res.status).toBe(400);
    expect(state.lastSet).toBeNull();
  });

  it("with a new token, a URL change is saved", async () => {
    const res = await send("PATCH", `/api/ci-connections/${ID}`, {
      baseUrl: "https://other.example.test",
      apiToken: "new-token",
    });
    expect(res.status).toBe(200);
    expect(state.lastSet).toMatchObject({
      baseUrl: "https://other.example.test",
    });
    expect(decryptSecret(state.lastSet?.apiToken as string)).toBe("new-token");
  });

  it("does not ask for the token when the URL is unchanged", async () => {
    const res = await send("PATCH", `/api/ci-connections/${ID}`, {
      baseUrl: "https://ci.example.test/",
    });
    expect(res.status).toBe(200);
    expect(state.lastSet).toMatchObject({ baseUrl: "https://ci.example.test" });
  });

  it("maps a unique-name violation to 400", async () => {
    state.updateError = Object.assign(new Error("dup"), { code: "23505" });
    const res = await send("PATCH", `/api/ci-connections/${ID}`, {
      name: "Taken",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("That name is already in use");
  });

  it("does not hide other database errors", async () => {
    state.updateError = new Error("connection lost");
    const res = await send("PATCH", `/api/ci-connections/${ID}`, {
      name: "Renamed",
    });
    expect(res.status).toBe(500);
  });

  it("rejects an invalid base URL with 400", async () => {
    const res = await send("PATCH", `/api/ci-connections/${ID}`, {
      baseUrl: "not a url",
    });
    expect(res.status).toBe(400);
  });

  it("answers 404 for an unknown connection", async () => {
    state.rows = [];
    const res = await send("PATCH", `/api/ci-connections/${ID}`, {
      name: "x",
    });
    expect(res.status).toBe(404);
  });
});

describe("getProviderForConnection", () => {
  it("decrypts the token for the provider", async () => {
    await getProviderForConnection(ID);
    expect(woodpecker.create).toHaveBeenCalledWith(
      "https://ci.example.test",
      "wp-secret-token"
    );
  });

  it("throws 409 when the token is missing", async () => {
    state.rows = [row({ apiToken: null })];
    await expect(getProviderForConnection(ID)).rejects.toMatchObject({
      status: 409,
      message: "This CI connection has no API token",
    });
  });

  it("throws 404 for an unknown connection", async () => {
    state.rows = [];
    await expect(getProviderForConnection(ID)).rejects.toMatchObject({
      status: 404,
    });
  });
});
