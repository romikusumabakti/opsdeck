import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "0197f3a0-1b2c-7def-8000-0123456789a1";
const PEM =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAabc\n-----END PUBLIC KEY-----\n";

const state = vi.hoisted(() => ({
  role: "admin" as string,
  rows: [] as Record<string, unknown>[],
  lastSet: null as Record<string, unknown> | null,
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
  fetchExtensionPublicKey: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/ci/woodpecker", () => ({
  createWoodpeckerProvider: woodpecker.create,
}));

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { encryptSecret, decryptSecret } = await import("@/lib/secrets");
const { CiProviderError } = await import("@/lib/ci/types");
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
    extensionPublicKey: null,
    extensionPublicKeyFetchedAt: null,
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
  woodpecker.create.mockReturnValue({
    fetchExtensionPublicKey: woodpecker.fetchExtensionPublicKey,
  });
  woodpecker.fetchExtensionPublicKey.mockResolvedValue(PEM);
});

describe("permissions", () => {
  it("a non-admin gets 403 on list, patch and refresh-key", async () => {
    state.role = "member";
    expect((await send("GET", "/api/ci-connections")).status).toBe(403);
    expect(
      (await send("PATCH", `/api/ci-connections/${ID}`, { name: "x" })).status
    ).toBe(403);
    expect(
      (await send("POST", `/api/ci-connections/${ID}/refresh-key`)).status
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
      hasExtensionKey: false,
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

describe("POST /api/ci-connections/:id/refresh-key", () => {
  it("stores the PEM the provider returns", async () => {
    const res = await send("POST", `/api/ci-connections/${ID}/refresh-key`);
    expect(res.status).toBe(200);
    expect(woodpecker.create).toHaveBeenCalledWith(
      "https://ci.example.test",
      "wp-secret-token"
    );
    expect(state.lastSet?.extensionPublicKey).toBe(PEM);
    expect(state.lastSet?.extensionPublicKeyFetchedAt).toBeInstanceOf(Date);
    const body = await res.json();
    expect(body.hasExtensionKey).toBe(true);
    expect(JSON.stringify(body)).not.toContain("BEGIN PUBLIC KEY");
  });

  it("answers 409 when there is no API token", async () => {
    state.rows = [row({ apiToken: null })];
    const res = await send("POST", `/api/ci-connections/${ID}/refresh-key`);
    expect(res.status).toBe(409);
    expect(woodpecker.create).not.toHaveBeenCalled();
  });

  it("answers 502 when Woodpecker fails, without storing", async () => {
    woodpecker.fetchExtensionPublicKey.mockRejectedValue(
      new CiProviderError(
        "Woodpecker GET /api/signature/public-key failed with 500",
        500
      )
    );
    const res = await send("POST", `/api/ci-connections/${ID}/refresh-key`);
    expect(res.status).toBe(502);
    expect(state.lastSet).toBeNull();
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
