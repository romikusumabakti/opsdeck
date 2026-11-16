import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  role: "admin" as string,
  row: null as Record<string, unknown> | null,
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

// Mirrors the database: an update merges into the stored row.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (state.row ? [state.row] : []) }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        state.lastSet = values;
        return {
          where: async () => {
            state.row = { ...state.row, ...values };
          },
        };
      },
    }),
  },
}));

const sdk = vi.hoisted(() => ({
  retrieve: vi.fn(),
  keys: [] as string[],
}));
vi.mock("@/lib/assistant/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant/client")>()),
  createAnthropicClient: (apiKey: string) => {
    sdk.keys.push(apiKey);
    return { models: { retrieve: sdk.retrieve } };
  },
}));

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { app } = await import("@/server/app");

const BASE = "/api/assistant-settings";

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
  state.lastSet = null;
  sdk.keys = [];
  state.row = {
    id: 1,
    assistantEnabled: false,
    anthropicApiKey: null,
    assistantModel: "claude-opus-5-5",
    assistantEffort: "medium",
    assistantDailyCapUsd: "1.50",
  };
});

describe("permissions", () => {
  it("answers 403 on every route without assistant:manage", async () => {
    state.role = "engineer";
    expect((await send("GET", BASE)).status).toBe(403);
    expect((await send("PUT", BASE, { enabled: true })).status).toBe(403);
    expect((await send("POST", `${BASE}/test`)).status).toBe(403);
    expect(state.lastSet).toBeNull();
    expect(sdk.retrieve).not.toHaveBeenCalled();
  });
});

describe("settings", () => {
  it("returns the defaults before anything is saved", async () => {
    const res = await send("GET", BASE);
    expect(await res.json()).toEqual({
      enabled: false,
      hasApiKey: false,
      model: "claude-opus-5-5",
      effort: "medium",
      dailyCapUsd: 1.5,
    });
  });

  it("stores the key encrypted and never returns it", async () => {
    const save = await send("PUT", BASE, {
      apiKey: "sk-ant-secret-value",
      enabled: true,
      model: "claude-sonnet-5-5",
      dailyCapUsd: 3,
    });
    expect(await save.json()).toMatchObject({ success: true });
    expect(String(state.lastSet?.anthropicApiKey)).toMatch(/^enc:v1:/);
    expect(state.lastSet?.assistantDailyCapUsd).toBe("3.00");

    const res = await send("GET", BASE);
    const text = await res.text();
    expect(text).not.toContain("sk-ant-secret-value");
    expect(text).not.toContain("enc:v1:");
    expect(JSON.parse(text)).toEqual({
      enabled: true,
      hasApiKey: true,
      model: "claude-sonnet-5-5",
      effort: "medium",
      dailyCapUsd: 3,
    });
  });

  it("keeps the key when it is omitted or blank, clears it on null", async () => {
    await send("PUT", BASE, { apiKey: "sk-ant-secret-value" });
    await send("PUT", BASE, { apiKey: "  " });
    await send("PUT", BASE, { enabled: true });
    expect((await (await send("GET", BASE)).json()).hasApiKey).toBe(true);
    await send("PUT", BASE, { apiKey: null });
    expect(state.row?.anthropicApiKey).toBeNull();
    expect((await (await send("GET", BASE)).json()).hasApiKey).toBe(false);
  });

  it("rejects a model outside the supported choices", async () => {
    const res = await send("PUT", BASE, { model: "claude-opus-4-8" });
    expect(res.status).toBe(400);
    expect(state.lastSet).toBeNull();
  });
});

describe("POST /test", () => {
  it("asks for a key first", async () => {
    const res = await send("POST", `${BASE}/test`);
    expect(await res.json()).toMatchObject({ success: false });
    expect(sdk.retrieve).not.toHaveBeenCalled();
  });

  it("retrieves the configured model with the decrypted key", async () => {
    await send("PUT", BASE, { apiKey: "sk-ant-secret-value" });
    sdk.retrieve.mockResolvedValue({ id: "claude-opus-5-5" });
    const res = await send("POST", `${BASE}/test`);
    expect(await res.json()).toMatchObject({ success: true });
    expect(sdk.retrieve).toHaveBeenCalledExactlyOnceWith("claude-opus-5-5");
    expect(sdk.keys).toEqual(["sk-ant-secret-value"]);
  });

  it("reports a failure without leaking the key", async () => {
    await send("PUT", BASE, { apiKey: "sk-ant-secret-value" });
    sdk.retrieve.mockRejectedValue(
      Object.assign(new Error("401 invalid x-api-key sk-ant-secret-value"), {
        status: 401,
      })
    );
    const text = await (await send("POST", `${BASE}/test`)).text();
    expect(JSON.parse(text)).toEqual({
      success: false,
      message: "Connection failed (HTTP 401)",
    });
    expect(text).not.toContain("sk-ant");
  });
});
