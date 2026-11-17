import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheControlFor,
  createLanguageModel,
  KNOWN_MODELS,
  PROVIDERS,
  providerOptionsFor,
  suggestedModels,
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

  it("openai: the reasoning effort", () => {
    expect(providerOptionsFor("openai", "high")).toEqual({
      openai: { reasoningEffort: "high" },
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

// Transitional: the old Anthropic-only runtime drafts still use reads the key
// the settings now store (assistant_api_key), for provider anthropic.
describe("loadLegacyDraftRuntime (transitional)", () => {
  const row = (patch: Record<string, unknown> = {}) => ({
    id: 1,
    assistantEnabled: true,
    anthropicApiKey: null,
    assistantProvider: "anthropic",
    assistantApiKey: encryptSecret("sk-test"),
    assistantModel: "claude-sonnet-5-5",
    assistantEffort: "medium",
    assistantDailyCapUsd: "1.50",
    assistantOrgContext: null,
    assistantPriceInput: "2.000000",
    assistantPriceOutput: "10.000000",
    assistantPriceCacheRead: "0.100000",
    assistantPriceCacheWrite: "2.500000",
    ...patch,
  });

  it("uses the stored assistant key for an Anthropic provider", async () => {
    state.row = row();
    const { loadLegacyDraftRuntime } = await import("@/lib/assistant/client");
    const runtime = await loadLegacyDraftRuntime();
    expect(runtime?.model).toBe("claude-sonnet-5-5");
    expect(runtime?.client.apiKey).toBe("sk-test");
    expect(runtime?.prices).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    });
  });

  it.each([
    ["another provider", { assistantProvider: "openai" }],
    ["no assistant key", { assistantApiKey: null }],
    ["no prices", { assistantPriceOutput: null }],
    [
      "only the superseded key",
      { assistantApiKey: null, anthropicApiKey: encryptSecret("sk-old") },
    ],
  ])("is null with %s", async (_label, patch) => {
    state.row = row(patch);
    const { loadLegacyDraftRuntime } = await import("@/lib/assistant/client");
    expect(await loadLegacyDraftRuntime()).toBeNull();
  });
});
