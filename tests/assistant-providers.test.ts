import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_EFFORTS,
  cacheControlFor,
  createLanguageModel,
  KNOWN_MODELS,
  outputTokenLimitFor,
  PROVIDER_LABEL_KEYS,
  PROVIDERS,
  type Prices,
  probeOptionsFor,
  providerOptionsFor,
  suggestedModels,
  titleModelFor,
} from "@/lib/assistant/providers";
import { encryptSecret } from "@/lib/secrets";

const state = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (state.row ? [state.row] : []) }),
      }),
    }),
  },
}));

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");

const config = (provider: (typeof PROVIDERS)[number]) => ({
  provider,
  apiKey: "test-key",
  baseUrl:
    provider === "openai-compatible" ? "https://llm.example.invalid/v1" : null,
  model: "some-model",
});

describe("createLanguageModel", () => {
  it.each(PROVIDERS)("builds a %s model without a network call", (provider) => {
    const model = createLanguageModel(config(provider));
    if (typeof model === "string") throw new Error("expected a model object");
    expect(model.provider.startsWith(provider)).toBe(true);
    expect(model.modelId).toBe("some-model");
  });

  it("refuses an OpenAI-compatible endpoint without a base URL", () => {
    expect(() =>
      createLanguageModel({ ...config("openai-compatible"), baseUrl: null })
    ).toThrow();
  });
});

describe("providerOptionsFor", () => {
  it("anthropic: adaptive thinking and the effort", () => {
    expect(providerOptionsFor("anthropic", "medium")).toEqual({
      anthropic: { thinking: { type: "adaptive" }, effort: "medium" },
    });
  });

  it("openai: the reasoning effort, nothing stored at OpenAI", () => {
    expect(providerOptionsFor("openai", "high")).toEqual({
      openai: { reasoningEffort: "high", store: false },
    });
  });

  it("google: the thinking level", () => {
    expect(providerOptionsFor("google", "low")).toEqual({
      google: { thinkingConfig: { thinkingLevel: "low" } },
    });
  });

  it("openai-compatible: nothing", () => {
    expect(providerOptionsFor("openai-compatible", "high")).toEqual({});
  });
});

describe("cacheControlFor", () => {
  it("marks an ephemeral cache breakpoint on anthropic only", () => {
    expect(cacheControlFor("anthropic")).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(cacheControlFor("openai")).toBeUndefined();
    expect(cacheControlFor("google")).toBeUndefined();
    expect(cacheControlFor("openai-compatible")).toBeUndefined();
  });
});

describe("outputTokenLimitFor", () => {
  it("sends a limit to anthropic only", () => {
    expect(outputTokenLimitFor("anthropic")).toBe(32_000);
    expect(outputTokenLimitFor("openai")).toBeUndefined();
    expect(outputTokenLimitFor("google")).toBeUndefined();
    expect(outputTokenLimitFor("openai-compatible")).toBeUndefined();
  });
});

describe("probeOptionsFor", () => {
  it("asks for the lowest reasoning where a provider has one", () => {
    expect(probeOptionsFor("openai")).toEqual({
      openai: { reasoningEffort: "low", store: false },
    });
    expect(probeOptionsFor("google")).toEqual({
      google: { thinkingConfig: { thinkingLevel: "low" } },
    });
    // Thinking conflicts with the forced tool choice.
    expect(probeOptionsFor("anthropic")).toBeUndefined();
    expect(probeOptionsFor("openai-compatible")).toBeUndefined();
  });
});

describe("PROVIDER_LABEL_KEYS and ASSISTANT_EFFORTS", () => {
  it("label every provider and list the efforts", () => {
    expect(Object.keys(PROVIDER_LABEL_KEYS)).toEqual([...PROVIDERS]);
    expect(PROVIDER_LABEL_KEYS.anthropic).toBe("providerAnthropic");
    expect(ASSISTANT_EFFORTS).toEqual(["low", "medium", "high"]);
  });
});

describe("suggestedModels", () => {
  it("lists the Claude 5.5 models with their prices", () => {
    const models = suggestedModels("anthropic");
    expect(models.find((m) => m.id === "claude-sonnet-5-5")?.prices).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    });
    expect(models.find((m) => m.id === "claude-opus-5-5")?.prices).toEqual({
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite: 5,
    });
  });

  it("returns only the provider's models; none for a compatible endpoint", () => {
    for (const provider of PROVIDERS) {
      for (const model of suggestedModels(provider)) {
        expect(model.provider).toBe(provider);
      }
    }
    expect(suggestedModels("openai").length).toBeGreaterThanOrEqual(2);
    expect(suggestedModels("google").length).toBeGreaterThanOrEqual(2);
    expect(suggestedModels("openai-compatible")).toEqual([]);
  });

  it("every known model has positive prices and a unique id", () => {
    const ids = KNOWN_MODELS.map((m) => `${m.provider}/${m.id}`);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { prices } of KNOWN_MODELS) {
      for (const price of Object.values(prices)) {
        expect(price).toBeGreaterThan(0);
      }
    }
  });
});

describe("loadAssistantRuntime", () => {
  const configured = () => ({
    id: 1,
    assistantEnabled: true,
    assistantProvider: "openai",
    assistantApiKey: encryptSecret("sk-test"),
    assistantBaseUrl: null,
    assistantModel: "gpt-test",
    assistantEffort: "high",
    assistantDailyCapUsd: "1.50",
    assistantOrgContext: "Acme builds widgets.",
    assistantPriceInput: "2.000000",
    assistantPriceOutput: "10.000000",
    assistantPriceCacheRead: "0.100000",
    assistantPriceCacheWrite: "2.500000",
  });

  beforeEach(() => {
    state.row = configured();
  });

  it("returns the configured model, prices and limits", async () => {
    const { loadAssistantRuntime } = await import("@/lib/assistant/client");
    const runtime = await loadAssistantRuntime();
    expect(runtime).not.toBeNull();
    if (!runtime || typeof runtime.model === "string")
      throw new Error("expected a runtime with a model object");
    expect(runtime.model.provider.startsWith("openai")).toBe(true);
    expect(runtime.model.modelId).toBe("gpt-test");
    expect(runtime).toMatchObject({
      provider: "openai",
      modelId: "gpt-test",
      effort: "high",
      prices: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
      dailyCapUsd: 1.5,
      orgContext: "Acme builds widgets.",
    });
    expect(JSON.stringify(Object.keys(runtime))).not.toMatch(/key/i);
  });

  it.each([
    ["disabled", { assistantEnabled: false }],
    ["no provider", { assistantProvider: null }],
    ["no key", { assistantApiKey: null }],
    ["no model", { assistantModel: null }],
    ["no input price", { assistantPriceInput: null }],
    ["no output price", { assistantPriceOutput: null }],
    ["no cache read price", { assistantPriceCacheRead: null }],
    ["no cache write price", { assistantPriceCacheWrite: null }],
    [
      "an OpenAI-compatible endpoint without a base URL",
      { assistantProvider: "openai-compatible" },
    ],
    [
      "only the superseded key is stored",
      { assistantApiKey: null, legacyApiKey: encryptSecret("sk-old") },
    ],
  ])("is null when %s", async (_label, patch) => {
    state.row = { ...configured(), ...patch };
    const { loadAssistantRuntime } = await import("@/lib/assistant/client");
    expect(await loadAssistantRuntime()).toBeNull();
  });

  it("is null without a settings row", async () => {
    state.row = null;
    const { loadAssistantRuntime } = await import("@/lib/assistant/client");
    expect(await loadAssistantRuntime()).toBeNull();
  });
});

describe("openai without server-side storage", () => {
  // A stubbed fetch stands in for the Responses API; nothing leaves the test.
  const responses = [
    {
      id: "resp_1",
      created_at: 1_790_000_000,
      model: "gpt-6.1-sol",
      status: "completed",
      output: [
        {
          type: "reasoning",
          id: "rs_1",
          encrypted_content: "opaque-reasoning",
          summary: [],
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "ping",
          arguments: '{"ok":true}',
          status: "completed",
        },
      ],
      usage: { input_tokens: 5, output_tokens: 3 },
    },
    {
      id: "resp_2",
      created_at: 1_790_000_001,
      model: "gpt-6.1-sol",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "done", annotations: [] }],
        },
      ],
      usage: { input_tokens: 9, output_tokens: 1 },
    },
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for encrypted reasoning and replays it in the next tool step", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(responses[bodies.length - 1]), {
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    const { generateText, stepCountIs, tool } = await import("ai");
    const { z } = await import("zod");
    const result = await generateText({
      model: createLanguageModel({
        provider: "openai",
        apiKey: "sk-test",
        baseUrl: "https://llm.example.invalid/v1",
        model: "gpt-6.1-sol",
      }),
      prompt: "ping",
      tools: {
        ping: tool({
          inputSchema: z.object({ ok: z.boolean() }),
          execute: async () => "pong",
        }),
      },
      stopWhen: stepCountIs(3),
      providerOptions: providerOptionsFor("openai", "medium"),
    });
    expect(result.text).toBe("done");
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.store).toBe(false);
      expect(body.include).toEqual(["reasoning.encrypted_content"]);
    }
    const input = bodies[1]?.input as Record<string, unknown>[];
    expect(input).toContainEqual(
      expect.objectContaining({
        type: "reasoning",
        encrypted_content: "opaque-reasoning",
      })
    );
    expect(input.some((item) => item.type === "item_reference")).toBe(false);
  });
});

// The configured model's stored prices in the titleModelFor cases.
const PRICES: Prices = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

describe("titleModelFor", () => {
  it("picks the provider's cheapest known model when it is cheaper", () => {
    expect(
      titleModelFor({
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        prices: PRICES,
        baseUrl: null,
      })
    ).toEqual({
      modelId: "claude-sonnet-5-5",
      prices: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    });
    expect(
      titleModelFor({
        provider: "openai",
        modelId: "gpt-6.1-sol",
        prices: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
        baseUrl: null,
      }).modelId
    ).toBe("gpt-6-luna");
    expect(
      titleModelFor({
        provider: "google",
        modelId: "gemini-4-carbon",
        prices: PRICES,
        baseUrl: null,
      }).modelId
    ).toBe("gemini-4-hydrogen");
  });

  it("keeps the configured model when nothing known is cheaper, for a custom endpoint, or an OpenAI-compatible one", () => {
    const cheap = { input: 0.05, output: 0.2, cacheRead: 0, cacheWrite: 0 };
    expect(
      titleModelFor({
        provider: "anthropic",
        modelId: "claude-mini-custom",
        prices: cheap,
        baseUrl: null,
      })
    ).toEqual({ modelId: "claude-mini-custom", prices: cheap });
    expect(
      titleModelFor({
        provider: "anthropic",
        modelId: "claude-opus-5-5",
        prices: PRICES,
        baseUrl: "https://llm-proxy.example.invalid/v1",
      })
    ).toEqual({ modelId: "claude-opus-5-5", prices: PRICES });
    expect(
      titleModelFor({
        provider: "openai-compatible",
        modelId: "local-model",
        prices: PRICES,
        baseUrl: "https://llm.example.invalid/v1",
      })
    ).toEqual({ modelId: "local-model", prices: PRICES });
  });
});
