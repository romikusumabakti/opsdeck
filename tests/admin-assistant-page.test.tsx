// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";

const api = vi.hoisted(() => ({
  save: vi.fn(),
  test: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/web/api/assistant-settings", () => ({
  getAssistantSettingsQuery: () => ({
    queryKey: ["assistant-settings", "getAssistantSettings"],
    queryFn: () => null,
  }),
  getAssistantUsageQuery: () => ({
    queryKey: ["assistant-settings", "getAssistantUsage"],
    queryFn: () => null,
  }),
  saveAssistantSettings: api.save,
  testAssistantConnection: api.test,
}));

const { Route } = await import("../web/routes/$locale/_app/admin.assistant");

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const t = messages.assistantSettings;

type Settings = {
  enabled: boolean;
  provider: string | null;
  hasApiKey: boolean;
  baseUrl: string | null;
  model: string | null;
  effort: string;
  prices: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  } | null;
  dailyCapUsd: number;
  orgContext: string | null;
};

const SETTINGS: Settings = {
  enabled: false,
  provider: "anthropic",
  hasApiKey: true,
  baseUrl: null,
  model: "claude-sonnet-5-5",
  effort: "medium",
  prices: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  dailyCapUsd: 1.5,
  orgContext: null,
};

const USAGE = { rows: [], totalUsd: 0, monthToDateUsd: 0, estimatedRows: 0 };

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(
  settings: Partial<Settings> = {},
  usage: Partial<typeof USAGE> = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(["assistant-settings", "getAssistantSettings"], {
    ...SETTINGS,
    ...settings,
  });
  queryClient.setQueryData(["assistant-settings", "getAssistantUsage"], {
    ...USAGE,
    ...usage,
  });
  const Page = Route.options.component as React.ComponentType;
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="en" messages={messages}>
          <Page />
        </IntlProvider>
      </QueryClientProvider>
    );
  });
}

const byId = (id: string) =>
  container.querySelector<HTMLInputElement>(`#${id}`);

const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === label
  );

async function type(el: HTMLInputElement | null, value: string) {
  if (!el) throw new Error("input missing");
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

// Dispatched on the form: happy-dom's constraint validation wrongly flags the
// daily cap as a step mismatch of step="0.01", so a click would not submit.
async function submit() {
  await act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function pickProvider(label: string) {
  await act(async () => byId("assistant-provider")?.click());
  const option = [...document.querySelectorAll("[role='option']")].find(
    (o) => o.textContent === label
  ) as HTMLElement | undefined;
  if (!option) throw new Error(`provider option ${label} missing`);
  await act(async () => option.click());
}

async function openAdvanced() {
  await act(async () => button(messages.setup.advancedOptions)?.click());
}

const prices = () =>
  [
    "assistant-price-input",
    "assistant-price-output",
    "assistant-price-cache-read",
    "assistant-price-cache-write",
  ].map((id) => byId(id)?.value);

beforeEach(() => {
  api.save.mockReset();
  api.save.mockResolvedValue({ success: true, message: "Saved" });
  api.test.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("/admin/assistant", () => {
  it("suggests the provider's models and prefills a known model's prices", async () => {
    await render();
    const model = byId("assistant-model");
    const list = model?.getAttribute("list");
    expect(list).toBeTruthy();
    const options = [
      ...container.querySelectorAll(`datalist#${list} option`),
    ].map((o) => o.getAttribute("value"));
    expect(options).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);

    await openAdvanced();
    expect(prices()).toEqual(["2", "10", "0.1", "2.5"]);
    await type(model, "claude-opus-5-5");
    expect(prices()).toEqual(["4", "20", "0.2", "5"]);
    // A free-text model keeps whatever prices are there, editable.
    await type(model, "claude-custom-fine-tune");
    expect(prices()).toEqual(["4", "20", "0.2", "5"]);
    await type(byId("assistant-price-output"), "18");

    await submit();
    expect(api.save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-custom-fine-tune",
        baseUrl: null,
        prices: { input: 4, output: 18, cacheRead: 0.2, cacheWrite: 5 },
      })
    );
    expect(api.save.mock.calls[0]?.[0]).not.toHaveProperty("apiKey");
  });

  it("shows the base URL outside Advanced for an OpenAI-compatible endpoint", async () => {
    await render({
      provider: "openai-compatible",
      baseUrl: "https://llm.example.invalid/v1",
      model: "acme-coder-9b",
      prices: null,
    });
    expect(byId("assistant-base-url")?.value).toBe(
      "https://llm.example.invalid/v1"
    );
    expect(byId("assistant-price-input")).toBeNull();
    expect(container.querySelectorAll("datalist option").length).toBe(0);
  });

  it("keeps the base URL under Advanced for the other providers", async () => {
    await render({ provider: "openai", model: "gpt-6-luna" });
    expect(byId("assistant-base-url")).toBeNull();
    await openAdvanced();
    expect(byId("assistant-base-url")?.value).toBe("");
  });

  it("refuses to save with some prices missing and opens Advanced", async () => {
    await render({ prices: null });
    await openAdvanced();
    await type(byId("assistant-price-input"), "1");
    await submit();
    expect(api.save).not.toHaveBeenCalled();
  });

  it("shows each capability the connection test found", async () => {
    api.test.mockResolvedValue({
      ok: true,
      tools: true,
      structuredOutput: false,
    });
    await render();
    await act(async () => button(t.test)?.click());
    const status = container.querySelector("[role='status']")?.textContent;
    expect(status).toContain(`${t.testTools}${t.testSupported}`);
    expect(status).toContain(`${t.testDrafts}${t.testUnsupported}`);
  });

  it("words a failed connection test by its class", async () => {
    api.test.mockResolvedValue({
      ok: false,
      tools: false,
      structuredOutput: false,
      error: "auth",
    });
    await render();
    await act(async () => button(t.test)?.click());
    expect(container.querySelector("[role='status']")?.textContent).toContain(
      t.testErrorAuth
    );
  });

  it("notes estimated costs only when there are some", async () => {
    await render();
    expect(container.textContent).not.toContain(t.estimatedNotice);
    act(() => root.unmount());
    root = createRoot(container);
    await render({}, { estimatedRows: 2 });
    expect(container.textContent).toContain(t.estimatedNotice);
  });

  it("switching provider drops the key, base URL, and a model the new provider doesn't list", async () => {
    await render({
      provider: "openai",
      model: "gpt-6-luna",
      baseUrl: "https://proxy.example.invalid/v1",
      prices: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    });
    expect(container.textContent).toContain(t.set);
    await pickProvider(t.providerGoogle);
    expect(byId("assistant-model")?.value).toBe("");
    const keyBadge = container.querySelector(
      "label[for='assistant-api-key'] + [data-slot='badge']"
    );
    expect(keyBadge?.textContent).toBe(t.notSet);
    expect(container.textContent).toContain(t.apiKeyRequired);
    await openAdvanced();
    expect(byId("assistant-base-url")?.value).toBe("");
    expect(prices()).toEqual(["", "", "", ""]);
    const options = [
      ...container.querySelectorAll(
        "datalist#assistant-model-suggestions option"
      ),
    ].map((o) => o.getAttribute("value"));
    expect(options).toEqual(["gemini-4-carbon", "gemini-4-hydrogen"]);
  });

  it("disables Test connection until the changes are saved", async () => {
    await render();
    expect(button(t.test)?.disabled).toBe(false);
    expect(container.textContent).not.toContain(t.testSaveFirst);
    await type(byId("assistant-model"), "claude-opus-5-5");
    expect(button(t.test)?.disabled).toBe(true);
    expect(container.textContent).toContain(t.testSaveFirst);
    await type(byId("assistant-model"), "claude-sonnet-5-5");
    expect(button(t.test)?.disabled).toBe(false);
  });

  it("names no vendor outside the provider choice", async () => {
    await render({ provider: "openai", model: "gpt-6-luna" });
    expect(container.innerHTML).not.toMatch(/claude|anthropic/i);
  });
});
