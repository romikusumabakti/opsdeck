import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
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

const activity = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: activity.record }));

const llm = vi.hoisted(() => ({
  // The model the route's test connection gets; set per test.
  model: null as unknown,
  configs: [] as unknown[],
}));
vi.mock("@/lib/assistant/providers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assistant/providers")>()),
  createLanguageModel: (config: unknown) => {
    llm.configs.push(config);
    return llm.model;
  },
}));

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { app } = await import("@/server/app");
const { testAssistantConnection } = await import(
  "@/server/services/assistant-settings"
);

const BASE = "/api/assistant-settings";
const KEY = "sk-test-secret-value";
const SONNET = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const USAGE = {
  inputTokens: {
    total: 5,
    noCache: 5,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
};
const STOP = { unified: "stop", raw: undefined } as const;

/** A model that answers both probes: the forced tool call and the JSON. */
function workingModel() {
  return new MockLanguageModelV4({
    doGenerate: async (options) => ({
      content: options.tools?.length
        ? [
            {
              type: "tool-call" as const,
              toolCallId: "call-1",
              toolName: "ping",
              input: '{"ok":true}',
            },
          ]
        : [{ type: "text" as const, text: '{"ok":true}' }],
      finishReason: options.tools?.length
        ? ({ unified: "tool-calls", raw: undefined } as const)
        : STOP,
      usage: USAGE,
      warnings: [],
    }),
  });
}

function failingModel(error: unknown) {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw error;
    },
  });
}

function apiError(statusCode: number | undefined, body = "") {
  return new APICallError({
    message: `request failed for key ${KEY}`,
    url: "https://llm.example.invalid/v1/chat",
    requestBodyValues: { apiKey: KEY },
    statusCode,
    responseBody: `${body} ${KEY}`,
  });
}

/** A complete, enabled-ready configuration. */
const complete = {
  provider: "anthropic",
  apiKey: KEY,
  model: "claude-sonnet-5-5",
  prices: SONNET,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.role = "admin";
  state.lastSet = null;
  llm.model = workingModel();
  llm.configs = [];
  state.row = {
    id: 1,
    assistantEnabled: false,
    anthropicApiKey: null,
    assistantProvider: null,
    assistantApiKey: null,
    assistantBaseUrl: null,
    assistantModel: null,
    assistantEffort: "medium",
    assistantPriceInput: null,
    assistantPriceOutput: null,
    assistantPriceCacheRead: null,
    assistantPriceCacheWrite: null,
    assistantDailyCapUsd: "1.50",
    assistantOrgContext: null,
  };
});

describe("permissions", () => {
  it("answers 403 on every route without assistant:manage", async () => {
    state.role = "engineer";
    expect((await send("GET", BASE)).status).toBe(403);
    expect((await send("PUT", BASE, { enabled: true })).status).toBe(403);
    expect((await send("POST", `${BASE}/test`)).status).toBe(403);
    expect(state.lastSet).toBeNull();
    expect(llm.configs).toEqual([]);
  });
});

describe("settings", () => {
  it("returns the defaults before anything is saved", async () => {
    const res = await send("GET", BASE);
    expect(await res.json()).toEqual({
      enabled: false,
      provider: null,
      hasApiKey: false,
      baseUrl: null,
      model: null,
      effort: "medium",
      prices: null,
      dailyCapUsd: 1.5,
      orgContext: null,
    });
  });

  it("stores provider, model, prices and the key encrypted, never returning it", async () => {
    const save = await send("PUT", BASE, {
      ...complete,
      enabled: true,
      dailyCapUsd: 3,
    });
    expect(await save.json()).toMatchObject({ success: true });
    expect(String(state.lastSet?.assistantApiKey)).toMatch(/^enc:v1:/);
    expect(state.lastSet).not.toHaveProperty("anthropicApiKey");
    expect(state.lastSet?.assistantDailyCapUsd).toBe("3.00");
    expect(state.lastSet?.assistantPriceCacheRead).toBe("0.100000");

    const res = await send("GET", BASE);
    const text = await res.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("enc:v1:");
    expect(JSON.parse(text)).toEqual({
      enabled: true,
      provider: "anthropic",
      hasApiKey: true,
      baseUrl: null,
      model: "claude-sonnet-5-5",
      effort: "medium",
      prices: SONNET,
      dailyCapUsd: 3,
      orgContext: null,
    });
  });

  it("accepts any model id up to 200 characters", async () => {
    const ok = await send("PUT", BASE, { model: "acme-coder-9b" });
    expect(await ok.json()).toMatchObject({ success: true });
    expect(state.row?.assistantModel).toBe("acme-coder-9b");
    for (const model of ["", "   ", "x".repeat(201)]) {
      state.lastSet = null;
      expect((await send("PUT", BASE, { model })).status).toBe(400);
      expect(state.lastSet).toBeNull();
    }
  });

  it("rejects prices outside 0..1000 and an unknown provider", async () => {
    for (const body of [
      { prices: { ...SONNET, input: -1 } },
      { prices: { ...SONNET, output: 1001 } },
      { prices: { input: 1, output: 1 } },
      { provider: "acme" },
      { baseUrl: "not a url" },
      { baseUrl: "ftp://llm.example.invalid" },
    ]) {
      expect((await send("PUT", BASE, body)).status).toBe(400);
    }
    expect(state.lastSet).toBeNull();
    const zero = await send("PUT", BASE, {
      prices: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(await zero.json()).toMatchObject({ success: true });
  });

  it("requires a base URL for an OpenAI-compatible provider", async () => {
    const res = await send("PUT", BASE, {
      provider: "openai-compatible",
      model: "acme-coder-9b",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "assistant.incomplete_settings",
    });
    expect(state.lastSet).toBeNull();

    const ok = await send("PUT", BASE, {
      provider: "openai-compatible",
      baseUrl: "https://llm.example.invalid/v1",
    });
    expect(await ok.json()).toMatchObject({ success: true });
    expect(state.row?.assistantBaseUrl).toBe("https://llm.example.invalid/v1");
    // Clearing it while the provider stays OpenAI-compatible is refused too.
    expect((await send("PUT", BASE, { baseUrl: null })).status).toBe(400);
  });

  it("clears the base URL when the provider changes, unless a new one comes along", async () => {
    await send("PUT", BASE, {
      provider: "openai",
      baseUrl: "https://proxy.example.invalid/v1",
    });
    expect(state.row?.assistantBaseUrl).toBe(
      "https://proxy.example.invalid/v1"
    );
    await send("PUT", BASE, { provider: "openai", model: "gpt-6-luna" });
    expect(state.row?.assistantBaseUrl).toBe(
      "https://proxy.example.invalid/v1"
    );
    await send("PUT", BASE, { provider: "google" });
    expect(state.row?.assistantBaseUrl).toBeNull();
    await send("PUT", BASE, {
      provider: "anthropic",
      baseUrl: "https://gateway.example.invalid",
    });
    expect(state.row?.assistantBaseUrl).toBe("https://gateway.example.invalid");
  });

  it("refuses to enable without provider, key, model and prices", async () => {
    const res = await send("PUT", BASE, {
      provider: "anthropic",
      apiKey: KEY,
      model: "claude-sonnet-5-5",
      enabled: true,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "assistant.incomplete_settings",
    });
    expect(state.lastSet).toBeNull();
    for (const missing of ["provider", "apiKey", "model"] as const) {
      const { [missing]: _, ...rest } = complete;
      const r = await send("PUT", BASE, { ...rest, enabled: true });
      expect(r.status).toBe(400);
    }
    expect(state.lastSet).toBeNull();
    const ok = await send("PUT", BASE, { ...complete, enabled: true });
    expect(await ok.json()).toMatchObject({ success: true });
    // Removing the key of an enabled assistant is refused as well.
    expect((await send("PUT", BASE, { apiKey: null })).status).toBe(400);
    expect(state.row?.assistantApiKey).toMatch(/^enc:v1:/);
  });

  it("keeps the key when it is omitted or blank, clears it on null", async () => {
    await send("PUT", BASE, { apiKey: KEY });
    await send("PUT", BASE, { apiKey: "  ", enabled: false });
    await send("PUT", BASE, { effort: "high" });
    expect((await (await send("GET", BASE)).json()).hasApiKey).toBe(true);
    await send("PUT", BASE, { apiKey: null });
    expect(state.row?.assistantApiKey).toBeNull();
    expect((await (await send("GET", BASE)).json()).hasApiKey).toBe(false);
  });

  it("stores the organisation context trimmed and clears it when blank", async () => {
    await send("PUT", BASE, { orgContext: "  Example Org runs funds.  " });
    expect(state.row?.assistantOrgContext).toBe("Example Org runs funds.");
    expect((await (await send("GET", BASE)).json()).orgContext).toBe(
      "Example Org runs funds."
    );
    await send("PUT", BASE, { effort: "low" });
    expect(state.row?.assistantOrgContext).toBe("Example Org runs funds.");
    await send("PUT", BASE, { orgContext: "   " });
    expect(state.row?.assistantOrgContext).toBeNull();
    await send("PUT", BASE, { orgContext: "Again." });
    await send("PUT", BASE, { orgContext: null });
    expect(state.row?.assistantOrgContext).toBeNull();
  });

  it("rejects an organisation context over 4000 characters", async () => {
    const res = await send("PUT", BASE, { orgContext: "x".repeat(4001) });
    expect(res.status).toBe(400);
    expect(state.lastSet).toBeNull();
    const ok = await send("PUT", BASE, { orgContext: "x".repeat(4000) });
    expect(await ok.json()).toMatchObject({ success: true });
  });
});

describe("activity log", () => {
  it("records which fields changed, never the key or the prices", async () => {
    await send("PUT", BASE, { ...complete, enabled: true });
    await send("PUT", BASE, { dailyCapUsd: 2 });
    await send("PUT", BASE, {
      model: "claude-opus-5-5",
      prices: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    });
    await send("PUT", BASE, {
      prices: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    });
    await send("PUT", BASE, { apiKey: "  ", enabled: false });
    await send("PUT", BASE, { apiKey: null, provider: "openai" });
    const calls = activity.record.mock.calls.map(([arg]) => arg);
    const flags = (name: string) => calls.map((c) => c.data[name]);
    expect(flags("keyChanged")).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
      "true",
    ]);
    expect(flags("providerChanged")).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
      "true",
    ]);
    expect(flags("modelChanged")).toEqual([
      "true",
      "false",
      "true",
      "false",
      "false",
      "false",
    ]);
    expect(flags("pricesChanged")).toEqual([
      "true",
      "false",
      "true",
      "false",
      "false",
      "false",
    ]);
    expect(calls[0]).toMatchObject({
      actorId: "user-1",
      action: "assistant.configured",
      data: {
        enabled: "true",
        model: "claude-sonnet-5-5",
        effort: "medium",
        dailyCapUsd: 1.5,
      },
    });
    expect(calls[1].data.dailyCapUsd).toBe(2);
    for (const call of calls) {
      expect(Object.keys(call.data).sort()).toEqual(
        [
          "dailyCapUsd",
          "effort",
          "enabled",
          "keyChanged",
          "model",
          "modelChanged",
          "orgContextChanged",
          "pricesChanged",
          "providerChanged",
        ].sort()
      );
    }
    const text = JSON.stringify(calls);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("enc:v1:");
    expect(text).not.toContain("anthropic");
    expect(text).not.toMatch(/"(2\.5|0\.1|0\.2|20|10|4)"/);
  });

  it("records orgContextChanged only when the context changes, never the text", async () => {
    await send("PUT", BASE, { orgContext: "Example Org runs funds." });
    await send("PUT", BASE, { orgContext: "Example Org runs funds." });
    await send("PUT", BASE, { effort: "high" });
    await send("PUT", BASE, { orgContext: "" });
    await send("PUT", BASE, { orgContext: null });
    const calls = activity.record.mock.calls.map(([arg]) => arg);
    expect(calls.map((c) => c.data.orgContextChanged)).toEqual([
      "true",
      "false",
      "false",
      "true",
      "false",
    ]);
    expect(JSON.stringify(calls)).not.toContain("Example Org");
  });

  it("records nothing for a rejected or forbidden save", async () => {
    await send("PUT", BASE, { model: "" });
    await send("PUT", BASE, { enabled: true });
    state.role = "engineer";
    await send("PUT", BASE, { effort: "low" });
    expect(activity.record).not.toHaveBeenCalled();
  });
});

describe("POST /test", () => {
  it("asks for provider, key and model first", async () => {
    const res = await send("POST", `${BASE}/test`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "assistant.incomplete_settings",
    });
    expect(llm.configs).toEqual([]);
  });

  it("probes tools and structured output with the decrypted key, at most 16 tokens each", async () => {
    await send("PUT", BASE, complete);
    const model = workingModel();
    llm.model = model;
    const res = await send("POST", `${BASE}/test`);
    expect(await res.json()).toEqual({
      ok: true,
      tools: true,
      structuredOutput: true,
    });
    expect(llm.configs).toEqual([
      {
        provider: "anthropic",
        apiKey: KEY,
        baseUrl: null,
        model: "claude-sonnet-5-5",
      },
    ]);
    expect(model.doGenerateCalls).toHaveLength(2);
    const [toolCall, objectCall] = model.doGenerateCalls;
    expect(toolCall?.toolChoice).toEqual({ type: "tool", toolName: "ping" });
    expect(toolCall?.tools?.map((t) => t.name)).toEqual(["ping"]);
    expect(objectCall?.responseFormat?.type).toBe("json");
    for (const call of model.doGenerateCalls) {
      expect(call.maxOutputTokens).toBeLessThanOrEqual(16);
    }
  });

  it("reports an auth failure without the key or the provider's message", async () => {
    await send("PUT", BASE, complete);
    llm.model = failingModel(apiError(401, "invalid x-api-key"));
    const res = await send("POST", `${BASE}/test`);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: false,
      tools: false,
      structuredOutput: false,
      error: "auth",
    });
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("invalid x-api-key");
  });

  it("maps quota, missing model, unreachable and other failures", async () => {
    await send("PUT", BASE, complete);
    const cases: [unknown, string][] = [
      [apiError(403), "auth"],
      [apiError(402), "quota"],
      [apiError(429), "quota"],
      [apiError(400, "Your credit balance is too low"), "quota"],
      [apiError(404), "model_not_found"],
      [apiError(undefined), "unreachable"],
      [apiError(500), "failed"],
      [new Error(`boom ${KEY}`), "failed"],
    ];
    for (const [error, expected] of cases) {
      const result = await testAssistantConnection({
        createModel: () => failingModel(error),
      });
      expect(result).toEqual({
        ok: false,
        tools: false,
        structuredOutput: false,
        error: expected,
      });
    }
  });

  it("reports tools working while structured output fails", async () => {
    await send("PUT", BASE, complete);
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        if (!options.tools?.length) {
          return {
            content: [{ type: "text" as const, text: "Sure, here you go" }],
            finishReason: STOP,
            usage: USAGE,
            warnings: [],
          };
        }
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "call-1",
              toolName: "ping",
              input: '{"ok":true}',
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined } as const,
          usage: USAGE,
          warnings: [],
        };
      },
    });
    const result = await testAssistantConnection({ createModel: () => model });
    expect(result).toEqual({ ok: true, tools: true, structuredOutput: false });
  });

  it("reports structured output working on a model that rejects tools", async () => {
    await send("PUT", BASE, complete);
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        if (options.tools?.length)
          throw apiError(400, "tools are not supported");
        return {
          content: [{ type: "text" as const, text: '{"ok":true}' }],
          finishReason: STOP,
          usage: USAGE,
          warnings: [],
        };
      },
    });
    const result = await testAssistantConnection({ createModel: () => model });
    expect(result).toEqual({ ok: true, tools: false, structuredOutput: true });
  });

  it("passes the base URL of an OpenAI-compatible endpoint", async () => {
    await send("PUT", BASE, {
      provider: "openai-compatible",
      apiKey: KEY,
      baseUrl: "https://llm.example.invalid/v1",
      model: "acme-coder-9b",
    });
    await send("POST", `${BASE}/test`);
    expect(llm.configs).toEqual([
      {
        provider: "openai-compatible",
        apiKey: KEY,
        baseUrl: "https://llm.example.invalid/v1",
        model: "acme-coder-9b",
      },
    ]);
  });
});
