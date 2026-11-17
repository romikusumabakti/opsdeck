import {
  APICallError,
  RetryError,
  StreamProviderError,
  simulateReadableStream,
  UnsupportedFunctionalityError,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantRuntime } from "@/lib/assistant/client";
import {
  cacheControlFor,
  outputTokenLimitFor,
  PROVIDERS,
  type Provider,
  type ProviderOptions,
  providerOptionsFor,
} from "@/lib/assistant/providers";
import type { AssistantSource } from "@/lib/assistant/sources";
import type { TurnContext } from "@/lib/assistant/turn-store";

type MessageRow = {
  status: string;
  content: string;
  errorCode: string | null;
  sources: unknown;
};

const state = vi.hoisted(() => ({
  turn: null as TurnContext | null,
  message: {
    status: "queued",
    content: "",
    errorCode: null,
    sources: null,
  } as {
    status: string;
    content: string;
    errorCode: string | null;
    sources: unknown;
  },
  contentWrites: [] as string[],
  toolCalls: [] as Array<{
    tool: string;
    input: Record<string, unknown>;
    resultMeta: Record<string, unknown>;
  }>,
  recordToolCallFails: false,
  usage: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        state.usage.push(row);
      },
    }),
  },
}));

vi.mock("@/lib/assistant/turn-store", () => ({
  loadTurn: vi.fn(async () => state.turn),
  claimMessage: vi.fn(async () => {
    if (state.message.status !== "queued") return false;
    state.message.status = "streaming";
    return true;
  }),
  saveContent: vi.fn(async (_id: string, content: string) => {
    state.contentWrites.push(content);
    state.message.content = content;
  }),
  saveSources: vi.fn(async (_id: string, sources: unknown) => {
    state.message.sources = sources;
  }),
  finishMessage: vi.fn(
    async (
      _id: string,
      outcome: { status: string; content: string; errorCode?: string }
    ) => {
      // Like the real WHERE status = 'streaming': first terminal write wins.
      if (state.message.status !== "streaming") return;
      state.message.status = outcome.status;
      state.message.content = outcome.content;
      state.message.errorCode = outcome.errorCode ?? null;
    }
  ),
  recordToolCall: vi.fn(
    async (
      _id: string,
      tool: string,
      input: Record<string, unknown>,
      resultMeta: Record<string, unknown>
    ) => {
      if (state.recordToolCallFails) throw new Error("db down");
      state.toolCalls.push({ tool, input, resultMeta });
    }
  ),
}));

const {
  runTurn,
  classifyError,
  TurnError,
  MAX_ITERATIONS,
  STEP_LIMIT_NOTE,
  DAILY_CAP_NOTE,
} = await import("@/lib/assistant/run-turn");
const { buildSourceNote, buildSystemPrompt, buildVolatileSystemNote } =
  await import("@/lib/assistant/system-prompt");
const { SnapshotUnavailableError } = await import("@/lib/assistant/snapshot");

// --- scripted mock model -----------------------------------------------------

type LanguageModelV4CallOptions = MockLanguageModelV4["doStreamCalls"][number];
type LanguageModelV4StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV4["doStream"]>
  >["stream"] extends ReadableStream<infer T>
    ? T
    : never;
type LanguageModelV4Usage = Extract<
  LanguageModelV4StreamPart,
  { type: "finish" }
>["usage"];

const USAGE: LanguageModelV4Usage = {
  inputTokens: {
    total: 8000,
    noCache: 1000,
    cacheRead: 5000,
    cacheWrite: 2000,
  },
  outputTokens: { total: 200, text: 200, reasoning: undefined },
};
const NO_USAGE: LanguageModelV4Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

type ToolCall = { id: string; name: string; input: unknown };
type Step =
  | {
      text?: string[];
      toolCalls?: ToolCall[];
      finish: "stop" | "tool-calls" | "length" | "content-filter";
      usage?: LanguageModelV4Usage;
    }
  /** The request itself fails (an HTTP error). */
  | { error: unknown }
  /** The stream fails after `text` (an SSE error event). */
  | { text?: string[]; streamError: unknown };

function chunksOf(step: Step): LanguageModelV4StreamPart[] {
  if ("error" in step) return [];
  const chunks: LanguageModelV4StreamPart[] = [
    { type: "response-metadata", modelId: "served-model-1" },
  ];
  if (step.text?.length) {
    chunks.push({ type: "text-start", id: "t" });
    for (const delta of step.text)
      chunks.push({ type: "text-delta", id: "t", delta });
    chunks.push({ type: "text-end", id: "t" });
  }
  if ("streamError" in step) {
    chunks.push({ type: "error", error: step.streamError });
    return chunks;
  }
  for (const call of step.toolCalls ?? []) {
    chunks.push({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.name,
      input: JSON.stringify(call.input),
    });
  }
  chunks.push({
    type: "finish",
    finishReason: { unified: step.finish, raw: step.finish },
    usage: step.usage ?? USAGE,
  });
  return chunks;
}

function mockModel(steps: Step[]) {
  const model = new MockLanguageModelV4({
    provider: "mock.provider",
    modelId: "configured-model",
    doStream: async () => {
      const step = steps.shift();
      if (!step) throw new Error("no scripted step left");
      if ("error" in step) throw step.error;
      return { stream: simulateReadableStream({ chunks: chunksOf(step) }) };
    },
  });
  return { model, calls: model.doStreamCalls as LanguageModelV4CallOptions[] };
}

const toolStep = (i: number): Step => ({
  toolCalls: [{ id: `tu_${i}`, name: "list_files", input: { glob: "**/*" } }],
  finish: "tool-calls",
});

/** The prompt messages of a call, without the two system messages. */
const conversationOf = (call: LanguageModelV4CallOptions | undefined) =>
  (call?.prompt ?? []).filter((m) => m.role !== "system");

/**
 * The source note of a call: the first text part of its latest user message
 * (the question being answered).
 */
const sourceNoteOf = (call: LanguageModelV4CallOptions | undefined) => {
  const question = conversationOf(call)
    .filter((m) => m.role === "user")
    .at(-1);
  const [first] = Array.isArray(question?.content) ? question.content : [];
  return first && first.type === "text" ? first.text : "";
};

/** The tool definitions of a call, with their provider options. */
const toolsOf = (call: LanguageModelV4CallOptions | undefined) =>
  (call?.tools ?? []) as Array<{ name: string; providerOptions?: unknown }>;

// --- fixtures ----------------------------------------------------------------

const MESSAGE_ID = "0198a000-0000-7000-8000-000000000002";
const USER_ID = "0198a000-0000-7000-8000-0000000000aa";

const SOURCE: AssistantSource = {
  componentKey: "backend",
  repoFullName: "acme/acme-membership",
  ciConnectionId: "conn-1",
  commitSha: "abcdef1234567890",
  ref: "abcdef1234567890",
  deployed: true,
  deployedAt: "2026-11-15T03:00:00.000Z",
};

/** The same component under "Project branches": its branch head. */
const PROJECT_SOURCE: AssistantSource = {
  componentKey: "backend",
  repoFullName: "acme/acme-membership",
  ciConnectionId: "conn-1",
  commitSha: null,
  ref: "kestrel/development",
  deployed: false,
  deployedAt: null,
};

function baseTurn(): TurnContext {
  return {
    messageId: MESSAGE_ID,
    status: "queued",
    content: "",
    conversationId: "conv-1",
    userId: USER_ID,
    userName: "Widya",
    projectId: "project-1",
    projectName: "Kestrel Membership",
    environmentId: "env-1",
    environmentName: "Dev 1",
    history: [
      {
        role: "user",
        content: "Bagaimana Iuran dihitung?",
        status: "done",
        environmentName: "Dev 1",
      },
    ],
    attachmentIds: [],
  };
}

// The provider whose requests carry prompt-cache breakpoints (the default
// runtime's), and its cache options.
const CACHING = PROVIDERS.find((p) => cacheControlFor(p)) as Provider;
const CACHE = cacheControlFor(CACHING) as ProviderOptions;

/** The request-level options: the provider's, plus its cache control. */
function requestOptions(provider: Provider, effort: "low" | "medium" | "high") {
  const options = providerOptionsFor(provider, effort);
  for (const [name, extra] of Object.entries(cacheControlFor(provider) ?? {})) {
    options[name] = { ...options[name], ...extra };
  }
  return options;
}

// Prices set apart from any list price, so the test proves they are used.
const PRICES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

function runtime(overrides: Partial<AssistantRuntime> = {}): AssistantRuntime {
  return {
    // Replaced by the injected mock in every test.
    model: "unused-model-id",
    provider: CACHING,
    modelId: "configured-model",
    effort: "medium",
    prices: PRICES,
    dailyCapUsd: 1.5,
    orgContext: null,
    ...overrides,
  };
}

function deps(
  model: MockLanguageModelV4,
  overrides: Record<string, unknown> = {}
): Parameters<typeof runTurn>[1] {
  let clock = Date.parse("2026-11-16T05:00:00.000Z");
  return {
    model,
    // Each read advances 500 ms, so every delta passes the flush throttle.
    now: () => {
      clock += 500;
      return new Date(clock);
    },
    loadRuntime: async () => runtime(),
    loadViewer: async () => ({
      userId: USER_ID,
      orgRole: "qa",
      projectIds: ["p1"],
      canManageKnowledge: false,
    }),
    spentToday: async () => 0,
    resolveSources: async () => [SOURCE],
    resolveProjectSources: async () => [PROJECT_SOURCE],
    ensureSnapshot: async () => ({
      dir: "/cache/acme__acme-membership/abcdef1234567890",
      commitSha: "abcdef1234567890",
      withheld: 0,
    }),
    executeTool: vi.fn(async () => ({
      ok: true as const,
      data: { matches: [{ path: "backend/src/Iuran.java", line: 42 }] },
      meta: { paths: ["backend/src/Iuran.java"] },
    })),
    ...overrides,
  } as Parameters<typeof runTurn>[1];
}

beforeEach(() => {
  state.turn = baseTurn();
  state.message = {
    status: "queued",
    content: "",
    errorCode: null,
    sources: null,
  } satisfies MessageRow;
  state.contentWrites = [];
  state.toolCalls = [];
  state.recordToolCallFails = false;
  state.usage = [];
});

// One response's cost at PRICES.
const ONE_RESPONSE_USD =
  (1000 * 3 + 200 * 15 + 5000 * 0.3 + 2000 * 3.75) / 1_000_000;

const spentSoFar = () =>
  state.usage.reduce((sum, row) => sum + Number(row.costUsd), 1.49);

describe("runTurn", () => {
  it("runs a tool call and ends done with the final text", async () => {
    const { model, calls } = mockModel([
      {
        toolCalls: [
          {
            id: "tu_1",
            name: "search_code",
            input: {
              pattern: "hitungIuran",
              regex: null,
              glob: null,
              ignore_case: null,
            },
          },
        ],
        finish: "tool-calls",
      },
      {
        text: ["Iuran dihitung ", "di `backend/src/Iuran.java:42`."],
        finish: "stop",
      },
    ]);

    await runTurn(MESSAGE_ID, deps(model));

    expect(state.message.status).toBe("done");
    expect(state.message.content).toBe(
      "Iuran dihitung di `backend/src/Iuran.java:42`."
    );
    expect(state.message.errorCode).toBeNull();
    expect(state.contentWrites.length).toBeGreaterThan(0);

    expect(state.toolCalls).toEqual([
      {
        tool: "search_code",
        input: {
          pattern: "hitungIuran",
          regex: null,
          glob: null,
          ignore_case: null,
        },
        resultMeta: { paths: ["backend/src/Iuran.java"] },
      },
    ]);

    expect(state.usage).toHaveLength(2);
    const total = state.usage.reduce((s, r) => s + Number(r.costUsd), 0);
    expect(total).toBeCloseTo(2 * ONE_RESPONSE_USD, 6);
    expect(state.usage[0]).toMatchObject({
      messageId: MESSAGE_ID,
      userId: USER_ID,
      model: "served-model-1",
      inputTokens: 1000,
      cacheReadTokens: 5000,
      cacheWriteTokens: 2000,
      outputTokens: 200,
      estimated: false,
      day: "2026-11-16",
    });

    // The second request carries the tool call and its JSON result.
    const second = conversationOf(calls[1]);
    expect(second.at(-2)).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "tu_1",
          toolName: "search_code",
        },
      ],
    });
    expect(second.at(-1)).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tu_1",
          output: {
            type: "text",
            value: JSON.stringify({
              matches: [{ path: "backend/src/Iuran.java", line: 42 }],
            }),
          },
        },
      ],
    });
    expect(state.message.sources).toEqual([SOURCE]);
  });

  it("keeps only the final response's text in content (R11)", async () => {
    const { model } = mockModel([
      {
        text: ["Saya cari dulu."],
        toolCalls: [
          { id: "tu_1", name: "list_files", input: { glob: "**/*Iuran*" } },
        ],
        finish: "tool-calls",
      },
      { text: ["Jawaban akhir."], finish: "stop" },
    ]);
    await runTurn(MESSAGE_ID, deps(model));

    expect(state.message.status).toBe("done");
    expect(state.message.content).toBe("Jawaban akhir.");
    // The intermediate text streamed live, then was cleared before the
    // final response's text.
    expect(state.contentWrites).toEqual([
      "Saya cari dulu.",
      "",
      "Jawaban akhir.",
    ]);
  });

  it("estimates a step the provider reports no usage for", async () => {
    const { model } = mockModel([
      { text: ["Halo"], finish: "stop", usage: NO_USAGE },
    ]);
    await runTurn(MESSAGE_ID, deps(model));
    expect(state.message.status).toBe("done");
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({
      estimated: true,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      // "Halo": 4 characters at 3 per token.
      outputTokens: 2,
    });
    // The prompt (system prompt included) is thousands of characters.
    expect(Number(state.usage[0]?.inputTokens)).toBeGreaterThan(500);
    expect(Number(state.usage[0]?.costUsd)).toBeGreaterThan(0);
  });

  it("derives uncached input from the total when the provider leaves it out", async () => {
    const { model } = mockModel([
      {
        text: ["Halo"],
        finish: "stop",
        usage: {
          inputTokens: {
            total: 8000,
            noCache: undefined,
            cacheRead: 5000,
            cacheWrite: undefined,
          },
          outputTokens: { total: 200, text: undefined, reasoning: undefined },
        },
      },
    ]);
    await runTurn(MESSAGE_ID, deps(model));
    expect(state.usage[0]).toMatchObject({
      inputTokens: 3000,
      cacheReadTokens: 5000,
      cacheWriteTokens: 0,
      outputTokens: 200,
      estimated: false,
    });
  });

  it.each([
    ["a PDF", "application/pdf", "document", 100_000],
    ["an image", "image/png", "image", 1_600],
  ])(
    "bounds the estimate after %s attachment",
    async (_label, mediaType, kind, allowance) => {
      const { model } = mockModel([
        {
          toolCalls: [
            {
              id: "tu_1",
              name: "read_attachment",
              input: { issue_key: "KST-1", attachment_id: "900" },
            },
          ],
          finish: "tool-calls",
        },
        { text: ["Isi lampiran: ..."], finish: "stop", usage: NO_USAGE },
      ]);
      // 5 MB of base64: counted as characters it would be ~1.7M tokens.
      const executeTool = vi.fn(async () => ({
        ok: true as const,
        data: { kind, mediaType, base64: "A".repeat(5_000_000) },
        meta: {},
      }));
      await runTurn(MESSAGE_ID, deps(model, { executeTool }));
      expect(state.message.status).toBe("done");
      const estimate = state.usage[1];
      expect(estimate).toMatchObject({ estimated: true });
      const input = Number(estimate?.inputTokens);
      expect(input).toBeGreaterThanOrEqual(allowance);
      // The allowance plus the text prompt (system prompt, tools, history).
      expect(input).toBeLessThan(allowance + 20_000);
    }
  );

  it.each(PROVIDERS)("sends the token limit of %s", async (provider) => {
    const { model, calls } = mockModel([{ text: ["Halo"], finish: "stop" }]);
    await runTurn(
      MESSAGE_ID,
      deps(model, { loadRuntime: async () => runtime({ provider }) })
    );
    expect(calls[0]?.maxOutputTokens).toBe(outputTokenLimitFor(provider));
  });

  it("audits invalid tool calls without running them", async () => {
    const { model } = mockModel([
      {
        toolCalls: [
          { id: "tu_1", name: "bash", input: { cmd: "ls" } },
          { id: "tu_2", name: "list_files", input: { glob: 1 } },
        ],
        finish: "tool-calls",
      },
      { text: ["ok"], finish: "stop" },
    ]);
    const executeTool = vi.fn();
    await runTurn(MESSAGE_ID, deps(model, { executeTool }));
    expect(executeTool).not.toHaveBeenCalled();
    expect(state.toolCalls).toEqual([
      { tool: "bash", input: { cmd: "ls" }, resultMeta: { invalid: true } },
      { tool: "list_files", input: { glob: 1 }, resultMeta: { invalid: true } },
    ]);
    expect(state.message.status).toBe("done");
  });

  it("keeps the partial text and meters an estimate when the stream fails", async () => {
    const overloaded = new StreamProviderError({
      message: "Overloaded",
      type: "overloaded_error",
      statusCode: 529,
      isRetryable: true,
    });
    const { model } = mockModel([
      { text: ["Sebagian"], streamError: overloaded },
    ]);
    await runTurn(MESSAGE_ID, deps(model));

    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.unavailable");
    expect(state.message.content).toBe("Sebagian");
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({ estimated: true });
  });

  it("sends auto tool choice, the effort, the token limit and cache control", async () => {
    const { model, calls } = mockModel([{ text: ["Halo"], finish: "stop" }]);
    await runTurn(MESSAGE_ID, deps(model));

    const call = calls[0]!;
    expect(call.toolChoice).toEqual({ type: "auto" });
    expect(call.maxOutputTokens).toBe(outputTokenLimitFor(CACHING));
    expect(call.temperature).toBeUndefined();
    // The effort, and the cache control (the growing conversation is cached
    // too).
    expect(call.providerOptions).toEqual(requestOptions(CACHING, "medium"));
    // Cache breakpoints: the stable system message and the last tool.
    const [cached, volatile] = call.prompt;
    expect(cached).toMatchObject({ role: "system", providerOptions: CACHE });
    expect(String(cached?.content)).not.toContain("2026-11-16");
    expect(volatile?.role).toBe("system");
    expect(volatile?.providerOptions).toBeUndefined();
    expect(String(volatile?.content)).toContain("2026-11-16");
    // The question's source travels with the question, not in a system
    // message, so switching it keeps the cached history prefix.
    expect(String(volatile?.content)).not.toContain("Environment:");
    const tools = toolsOf(call);
    expect(tools).toHaveLength(7);
    expect(tools.at(-1)?.providerOptions).toEqual(CACHE);
    expect(tools.slice(0, -1).some((t) => t.providerOptions)).toBe(false);
    expect(conversationOf(call)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: sourceNoteOf(call) },
          { type: "text", text: "Bagaimana Iuran dihitung?" },
        ],
      },
    ]);
    expect(sourceNoteOf(call)).toContain("Environment: Dev 1");
  });

  it("sends no cache options for a provider without breakpoints", async () => {
    const { model, calls } = mockModel([{ text: ["Halo"], finish: "stop" }]);
    await runTurn(
      MESSAGE_ID,
      deps(model, {
        loadRuntime: async () =>
          runtime({ provider: "openai" satisfies Provider, effort: "high" }),
      })
    );
    const call = calls[0]!;
    // Nothing of the turn is stored at OpenAI.
    expect(call.providerOptions).toEqual({
      openai: { reasoningEffort: "high", store: false },
    });
    for (const name of Object.keys(CACHE)) {
      expect(JSON.stringify(call)).not.toContain(`"${name}"`);
    }
    expect(call.prompt[0]?.providerOptions).toBeUndefined();
    expect(toolsOf(call).some((t) => t.providerOptions)).toBe(false);
    expect(state.message.status).toBe("done");
  });

  it("puts the configured organisation context in the cached system message", async () => {
    const { model, calls } = mockModel([{ text: ["Halo"], finish: "stop" }]);
    await runTurn(
      MESSAGE_ID,
      deps(model, {
        loadRuntime: async () =>
          runtime({ orgContext: "Example Org runs pension funds." }),
      })
    );
    const [cached, volatile] = calls[0]?.prompt ?? [];
    expect(String(cached?.content)).toContain(
      "Example Org runs pension funds."
    );
    expect(String(volatile?.content)).not.toContain("Example Org");
  });

  it("fails with credit_exhausted on a billing error without retrying", async () => {
    const billing = new APICallError({
      message: "Your credit balance is too low.",
      url: "https://api.example.invalid/v1/messages",
      requestBodyValues: {},
      statusCode: 400,
      responseBody:
        '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the API."}}',
      isRetryable: false,
    });
    const { model, calls } = mockModel([{ error: billing }]);

    await runTurn(MESSAGE_ID, deps(model));

    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.credit_exhausted");
    expect(calls).toHaveLength(1);
    expect(state.usage).toHaveLength(0);
  });

  it("fails with model_no_tools when the model cannot call tools", async () => {
    const { model } = mockModel([
      { error: new UnsupportedFunctionalityError({ functionality: "tools" }) },
    ]);
    await runTurn(MESSAGE_ID, deps(model));
    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.model_no_tools");
  });

  it("sends the last allowed request with tool choice none and the step-limit note, and keeps its answer", async () => {
    const steps: Step[] = Array.from({ length: MAX_ITERATIONS - 1 }, (_, i) =>
      toolStep(i)
    );
    steps.push({ text: ["Temuan sejauh ini: ..."], finish: "stop" });
    const { model, calls } = mockModel(steps);

    await runTurn(MESSAGE_ID, deps(model));

    expect(calls).toHaveLength(MAX_ITERATIONS);
    expect(calls.slice(0, -1).map((c) => c.toolChoice)).toEqual(
      Array(MAX_ITERATIONS - 1).fill({ type: "auto" })
    );
    const last = calls.at(-1)!;
    expect(last.toolChoice).toEqual({ type: "none" });
    // Same tools, so the cached tools + system prefix still holds.
    expect(last.tools).toEqual(calls[0]?.tools);
    const lastMessages = conversationOf(last);
    expect(lastMessages.at(-2)?.role).toBe("tool");
    expect(lastMessages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: STEP_LIMIT_NOTE }],
    });
    // Only the request after the last tool results carries the note.
    expect(conversationOf(calls.at(-2)).at(-1)?.role).toBe("tool");

    expect(state.toolCalls).toHaveLength(MAX_ITERATIONS - 1);
    expect(state.message.status).toBe("done");
    expect(state.message.content).toBe("Temuan sejauh ini: ...");
  });

  it("fails with daily_cap_reached before any request once the cap is spent", async () => {
    const { model, calls } = mockModel([]);
    await runTurn(MESSAGE_ID, deps(model, { spentToday: async () => 1.5 }));
    expect(calls).toHaveLength(0);
    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.daily_cap_reached");
  });

  it("re-checks the cap before each request and sends one final answer-only request once it is reached", async () => {
    const { model, calls } = mockModel([
      toolStep(1),
      { text: ["Jawaban dengan temuan yang ada"], finish: "stop" },
    ]);
    // Under the cap at the start; over it once the first response is metered.
    const spentToday = vi.fn(async () => spentSoFar());
    await runTurn(MESSAGE_ID, deps(model, { spentToday }));
    expect(calls).toHaveLength(2);
    expect(spentToday).toHaveBeenCalledTimes(2);
    expect(spentToday).toHaveBeenCalledWith(USER_ID, expect.any(Date));
    expect(calls[0]?.toolChoice).toEqual({ type: "auto" });
    expect(calls[1]?.toolChoice).toEqual({ type: "none" });
    expect(calls[1]?.tools).toEqual(calls[0]?.tools);
    const messages = conversationOf(calls[1]);
    expect(messages.at(-2)?.role).toBe("tool");
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: DAILY_CAP_NOTE }],
    });
    expect(state.toolCalls).toHaveLength(1);
    // Both requests are metered.
    expect(state.usage).toHaveLength(2);
    expect(state.message.status).toBe("done");
    expect(state.message.content).toBe("Jawaban dengan temuan yang ada");
  });

  it("fails with daily_cap_reached when the final capped request still asks for tools, without running them", async () => {
    const { model, calls } = mockModel([
      toolStep(1),
      toolStep(2),
      { text: ["never sent"], finish: "stop" },
    ]);
    const spentToday = vi.fn(async () => spentSoFar());
    await runTurn(MESSAGE_ID, deps(model, { spentToday }));
    expect(calls).toHaveLength(2);
    expect(state.toolCalls).toHaveLength(1);
    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.daily_cap_reached");
  });

  it("stops after 25 requests and fails with too_many_steps", async () => {
    const steps = Array.from({ length: MAX_ITERATIONS + 1 }, (_, i) =>
      toolStep(i)
    );
    const { model, calls } = mockModel(steps);

    await runTurn(MESSAGE_ID, deps(model));

    expect(MAX_ITERATIONS).toBe(25);
    expect(calls).toHaveLength(MAX_ITERATIONS);
    // The last request's tool calls are not run.
    expect(state.toolCalls).toHaveLength(MAX_ITERATIONS - 1);
    expect(state.usage).toHaveLength(MAX_ITERATIONS);
    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.too_many_steps");
    expect(state.message.content).toBe("");
  });

  it("fails the turn when a tool call cannot be audited", async () => {
    state.recordToolCallFails = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { model, calls } = mockModel([
      toolStep(1),
      { text: ["never sent"], finish: "stop" },
    ]);
    await runTurn(MESSAGE_ID, deps(model));
    expect(calls).toHaveLength(1);
    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.failed");
    // The step that asked for the tool is still metered.
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({
      estimated: false,
      inputTokens: 1000,
    });
    // The original error is logged, never sent to the model.
    expect(
      error.mock.calls.some((args) =>
        args.some((a) => a instanceof Error && a.message === "db down")
      )
    ).toBe(true);
    error.mockRestore();
  });

  it("fails with not_configured when the runtime is missing or its key cannot be decrypted", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { model, calls } = mockModel([]);
    await runTurn(MESSAGE_ID, deps(model, { loadRuntime: async () => null }));
    expect(state.message.errorCode).toBe("assistant.not_configured");

    state.message = {
      status: "queued",
      content: "",
      errorCode: null,
      sources: null,
    };
    await runTurn(
      MESSAGE_ID,
      deps(model, {
        loadRuntime: async () => {
          throw new Error("Unsupported state or unable to authenticate data");
        },
      })
    );
    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.not_configured");
    expect(calls).toHaveLength(0);
    error.mockRestore();
  });

  it("fails with refused when the provider's content filter stops the answer", async () => {
    const { model } = mockModel([
      { text: ["Mulai"], finish: "content-filter" },
    ]);
    await runTurn(MESSAGE_ID, deps(model));
    expect(state.message.errorCode).toBe("assistant.refused");
    expect(state.message.content).toBe("Mulai");
    expect(state.usage).toHaveLength(1);
  });

  it("fails a truncated answer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { model } = mockModel([{ text: ["Pot"], finish: "length" }]);
    await runTurn(MESSAGE_ID, deps(model));
    expect(state.message.errorCode).toBe("assistant.failed");
    expect(state.message.content).toBe("Pot");
    error.mockRestore();
  });

  it("names unavailable components and still runs the turn", async () => {
    const { model, calls } = mockModel([{ text: ["ok"], finish: "stop" }]);
    await runTurn(
      MESSAGE_ID,
      deps(model, {
        ensureSnapshot: async () => {
          throw new SnapshotUnavailableError("unsupported-forge");
        },
      })
    );
    const note = sourceNoteOf(calls[0]);
    expect(note).toContain("unavailable: unsupported-forge");
    expect(note).toContain("No source code is available");
    expect(state.message.status).toBe("done");
    expect(state.message.sources).toEqual([{ ...SOURCE, commitSha: null }]);
  });

  it("reads the running commits when the question names an environment", async () => {
    const resolveSources = vi.fn(async () => [SOURCE]);
    const resolveProjectSources = vi.fn(async () => [PROJECT_SOURCE]);
    const { model, calls } = mockModel([{ text: ["ok"], finish: "stop" }]);
    await runTurn(
      MESSAGE_ID,
      deps(model, { resolveSources, resolveProjectSources })
    );
    expect(resolveSources).toHaveBeenCalledExactlyOnceWith("env-1");
    expect(resolveProjectSources).not.toHaveBeenCalled();
    const note = sourceNoteOf(calls[0]);
    expect(note).toContain("Environment: Dev 1");
    expect(note).not.toContain("Source: project branches");
    expect(note).toContain(
      "- backend: repo acme/acme-membership, commit abcdef1234, deployed at"
    );
    expect(state.message.sources).toEqual([SOURCE]);
  });

  it("reads the project branches when the question names no environment", async () => {
    state.turn = { ...baseTurn(), environmentId: null, environmentName: null };
    const resolveSources = vi.fn(async () => [SOURCE]);
    const resolveProjectSources = vi.fn(async () => [PROJECT_SOURCE]);
    const ensureSnapshot = vi.fn(async () => ({
      dir: "/cache/acme__acme-membership/9999999999cccc",
      commitSha: "9999999999cccc",
      withheld: 0,
    }));
    const { model, calls } = mockModel([{ text: ["ok"], finish: "stop" }]);
    await runTurn(
      MESSAGE_ID,
      deps(model, { resolveSources, resolveProjectSources, ensureSnapshot })
    );
    expect(resolveProjectSources).toHaveBeenCalledExactlyOnceWith("project-1");
    expect(resolveSources).not.toHaveBeenCalled();
    expect(ensureSnapshot).toHaveBeenCalledWith(PROJECT_SOURCE);
    const note = sourceNoteOf(calls[0]);
    expect(note).toContain("Source: project branches");
    expect(note).not.toContain("Environment:");
    expect(note).toContain(
      "- backend: repo acme/acme-membership, commit 9999999999, branch kestrel/development head"
    );
    // The commit read is stored, so the answer stays reproducible.
    expect(state.message.sources).toEqual([
      { ...PROJECT_SOURCE, commitSha: "9999999999cccc" },
    ]);
    expect(state.message.status).toBe("done");
  });

  it("keeps the cached system message identical whatever the question's source", async () => {
    const cachedOf = async (turn: TurnContext) => {
      state.turn = turn;
      state.message = {
        status: "queued",
        content: "",
        errorCode: null,
        sources: null,
      };
      const { model, calls } = mockModel([{ text: ["ok"], finish: "stop" }]);
      await runTurn(MESSAGE_ID, deps(model));
      return calls[0]?.prompt[0];
    };
    const environment = await cachedOf(baseTurn());
    const project = await cachedOf({
      ...baseTurn(),
      environmentId: null,
      environmentName: null,
    });
    expect(environment).toMatchObject({ providerOptions: CACHE });
    expect(project).toEqual(environment);
    expect(String(project?.content)).not.toContain("Dev 1");
    expect(String(project?.content)).not.toContain("kestrel/development");
  });

  it("replays the earlier messages byte-identically whatever the new question's source", async () => {
    const history: TurnContext["history"] = [
      {
        role: "user",
        content: "Di Dev 1?",
        status: "done",
        environmentName: "Dev 1",
      },
      {
        role: "assistant",
        content: "Jawab 1",
        status: "done",
        environmentName: null,
      },
      {
        role: "user",
        content: "Di branch?",
        status: "done",
        environmentName: null,
      },
      {
        role: "assistant",
        content: "Jawab 2",
        status: "done",
        environmentName: null,
      },
      { role: "user", content: "Lalu?", status: "done", environmentName: null },
    ];
    const promptOf = async (turn: TurnContext) => {
      state.turn = turn;
      state.message = {
        status: "queued",
        content: "",
        errorCode: null,
        sources: null,
      };
      const { model, calls } = mockModel([{ text: ["ok"], finish: "stop" }]);
      await runTurn(MESSAGE_ID, deps(model));
      return calls[0]?.prompt ?? [];
    };
    const environment = await promptOf({ ...baseTurn(), history });
    const project = await promptOf({
      ...baseTurn(),
      history,
      environmentId: null,
      environmentName: null,
    });
    // Everything before the new question: both system messages and the
    // replayed turns.
    expect(project.slice(0, -1)).toEqual(environment.slice(0, -1));
    expect(project.length).toBe(environment.length);
    expect(project.at(-1)).not.toEqual(environment.at(-1));
  });

  it("fails with environment_gone when the question's environment was deleted", async () => {
    state.turn = {
      ...baseTurn(),
      environmentId: null,
      environmentName: "Dev 1",
    };
    const resolveSources = vi.fn(async () => [SOURCE]);
    const resolveProjectSources = vi.fn(async () => [PROJECT_SOURCE]);
    const { model, calls } = mockModel([]);
    await runTurn(
      MESSAGE_ID,
      deps(model, { resolveSources, resolveProjectSources })
    );
    expect(calls).toHaveLength(0);
    expect(resolveSources).not.toHaveBeenCalled();
    expect(resolveProjectSources).not.toHaveBeenCalled();
    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.environment_gone");
    expect(state.usage).toEqual([]);
  });

  it("rebuilds the history as text and skips empty failed answers", async () => {
    state.turn = {
      ...baseTurn(),
      history: [
        { role: "user", content: "Q1", status: "done", environmentName: "UAT" },
        {
          role: "assistant",
          content: "A1",
          status: "done",
          environmentName: null,
        },
        { role: "user", content: "Q2", status: "done", environmentName: null },
        {
          role: "assistant",
          content: "",
          status: "failed",
          environmentName: null,
        },
        {
          role: "user",
          content: "Q3",
          status: "done",
          environmentName: "Dev 1",
        },
      ],
      // A malformed (pre-pair) entry is dropped.
      attachmentIds: ["KST-12:10001", "10002"],
    };
    const { model, calls } = mockModel([{ text: ["A3"], finish: "stop" }]);
    await runTurn(MESSAGE_ID, deps(model));
    const text = (t: string) => [{ type: "text", text: t }];
    // Earlier questions name the source they asked about, so the model
    // knows their answers may cite other commits.
    expect(conversationOf(calls[0])).toEqual([
      { role: "user", content: text("(Source: environment UAT)\nQ1") },
      { role: "assistant", content: text("A1") },
      { role: "user", content: text("(Source: project branches)\nQ2") },
      {
        role: "user",
        content: [
          { type: "text", text: sourceNoteOf(calls[0]) },
          {
            type: "text",
            text: "Q3\n\n(Attachments ticked for this question, readable with read_attachment:\n- issue_key KST-12, attachment_id 10001)",
          },
        ],
      },
    ]);
    expect(sourceNoteOf(calls[0])).toMatch(/^# Source of this question\n/);
  });

  it("fails a redelivered turn that was already streaming as interrupted", async () => {
    state.turn = { ...baseTurn(), status: "streaming", content: "Sebagian" };
    state.message.status = "streaming";
    const { model, calls } = mockModel([]);
    await runTurn(MESSAGE_ID, deps(model));
    expect(calls).toHaveLength(0);
    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.interrupted");
    expect(state.message.content).toBe("Sebagian");
  });

  it("does nothing for a turn that is already finished", async () => {
    state.turn = { ...baseTurn(), status: "done" };
    state.message.status = "done";
    const { model, calls } = mockModel([]);
    await runTurn(MESSAGE_ID, deps(model));
    expect(calls).toHaveLength(0);
    expect(state.message.status).toBe("done");
  });
});

describe("classifyError", () => {
  const api = (statusCode: number | undefined, responseBody = "{}") =>
    new APICallError({
      message: "request failed",
      url: "https://api.example.invalid/v1",
      requestBodyValues: {},
      statusCode,
      responseBody,
    });

  it.each([
    ["401", api(401), "assistant.not_configured"],
    ["403", api(403), "assistant.not_configured"],
    [
      "400 naming the API key",
      api(400, '{"error":{"message":"API key not valid"}}'),
      "assistant.not_configured",
    ],
    ["402", api(402), "assistant.credit_exhausted"],
    [
      "400 credit balance",
      api(400, '{"message":"Your credit balance is too low"}'),
      "assistant.credit_exhausted",
    ],
    [
      "400 quota",
      api(400, '{"message":"quota exceeded for this key"}'),
      "assistant.credit_exhausted",
    ],
    [
      "429 insufficient_quota",
      api(
        429,
        '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}'
      ),
      "assistant.credit_exhausted",
    ],
    [
      "429 credit balance",
      api(429, '{"message":"Your credit balance is too low"}'),
      "assistant.credit_exhausted",
    ],
    [
      "429 per-day quota",
      api(
        429,
        '{"error":{"details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel"}]}}'
      ),
      "assistant.credit_exhausted",
    ],
    [
      "429 per-minute quota",
      api(
        429,
        '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. Please retry in 30s.","status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel"}]}}'
      ),
      "assistant.unavailable",
    ],
    [
      "429 billing wording only",
      api(429, '{"message":"check your plan and billing details"}'),
      "assistant.unavailable",
    ],
    [
      "429 rate limit",
      api(429, '{"message":"Rate limit reached"}'),
      "assistant.unavailable",
    ],
    ["500", api(500), "assistant.unavailable"],
    ["529", api(529), "assistant.unavailable"],
    ["no status (connection)", api(undefined), "assistant.unavailable"],
    [
      "stream error 529",
      new StreamProviderError({
        message: "Overloaded",
        statusCode: 529,
        isRetryable: true,
      }),
      "assistant.unavailable",
    ],
    [
      "retries exhausted",
      new RetryError({
        message: "x",
        reason: "maxRetriesExceeded",
        errors: [api(529)],
      }),
      "assistant.unavailable",
    ],
    [
      "unsupported tools",
      new UnsupportedFunctionalityError({ functionality: "tools" }),
      "assistant.model_no_tools",
    ],
    [
      "unsupported tool choice",
      new UnsupportedFunctionalityError({
        functionality: "tool choice type: none",
      }),
      "assistant.model_no_tools",
    ],
    [
      "400 tools unsupported",
      api(400, '{"error":"model does not support tools"}'),
      "assistant.model_no_tools",
    ],
    [
      "400 function calling unsupported",
      api(400, '{"message":"Function calling is not supported by this model"}'),
      "assistant.model_no_tools",
    ],
    [
      "400 tool use unsupported",
      api(400, '{"error":"this endpoint does not support tool use"}'),
      "assistant.model_no_tools",
    ],
    [
      "400 tool schema, not support",
      api(400, '{"message":"tools[0].input_schema: unsupported keyword"}'),
      "assistant.failed",
    ],
    [
      "unsupported other",
      new UnsupportedFunctionalityError({ functionality: "audio input" }),
      "assistant.failed",
    ],
    ["400 other", api(400, '{"message":"bad"}'), "assistant.failed"],
    ["plain error", new Error("boom"), "assistant.failed"],
    [
      "turn error",
      new TurnError("assistant.too_many_steps"),
      "assistant.too_many_steps",
    ],
  ])("%s", (_label, error, code) => {
    expect(classifyError(error)).toBe(code);
  });
});

describe("buildSystemPrompt", () => {
  const prompt = (orgContext: string | null = null) =>
    buildSystemPrompt({
      projectName: "Kestrel Membership",
      userName: "Widya",
      orgContext,
    });

  type NoteSources = Parameters<typeof buildSourceNote>[0]["sources"];
  const environmentNote = (sources: NoteSources) =>
    buildSourceNote({
      source: { kind: "environment", environmentName: "Dev 1" },
      sources,
    });
  const projectNote = (sources: NoteSources) =>
    buildSourceNote({ source: { kind: "project" }, sources });

  const GENERIC =
    "an internal operations portal of a company that builds and runs pension-fund (DPLK/DPPK) systems";

  it("describes the organisation generically when none is configured", () => {
    const text = prompt();
    expect(text).toContain(GENERIC);
    expect(text).not.toContain("# Organisation");
  });

  it("explains the pension-fund domain with or without a context", () => {
    for (const text of [prompt(), prompt("Example Org runs pension funds.")]) {
      expect(text).toContain("# Domain");
      for (const term of [
        "DPLK (Dana Pensiun Lembaga Keuangan)",
        "DPPK (Dana Pensiun Pemberi Kerja)",
        "participant membership (Kepesertaan)",
        "contributions (Iuran)",
        "pension benefits (Manfaat Pensiun)",
      ]) {
        expect(text).toContain(term);
      }
    }
  });

  it("includes the configured organisation context instead", () => {
    const text = prompt("Example Org runs pension funds.");
    expect(text).toContain("# Organisation\nExample Org runs pension funds.");
    expect(text).not.toContain(GENERIC);
    expect(prompt("Example Org runs pension funds.")).toBe(text);
  });

  it("names the project and the answer rules, but no source", () => {
    const text = prompt();
    expect(text).toContain("Project: Kestrel Membership");
    // Both sources are explained; which one applies is in the volatile note.
    expect(text).toContain('"Source: project branches"');
    expect(text).toContain('"Environment: <name>"');
    expect(text).not.toContain("Components and the source you can read");
    expect(text).not.toContain("Today's date");
    expect(text).toContain("tidak ditemukan di kode");
    expect(text).toContain("Yang dilakukan kode");
    expect(text).toContain("Asumsi");
    expect(text).toContain("Indonesian");
    expect(text).toContain("component/path:line");
  });

  it("states each component's source state for an environment", () => {
    const text = environmentNote([
      SOURCE,
      {
        ...SOURCE,
        componentKey: "legacy",
        commitSha: "1111111111aaaa",
        ref: "release/kestrel",
      },
      {
        ...SOURCE,
        componentKey: "portal",
        deployed: false,
        deployedAt: null,
        commitSha: "2222222222bbbb",
        ref: "kestrel/development",
      },
      {
        ...SOURCE,
        componentKey: "cms",
        commitSha: null,
        unavailableReason: "no-credentials",
      },
    ]);
    expect(text).toContain("Environment: Dev 1");
    expect(text).toContain(
      "- backend: repo acme/acme-membership, commit abcdef1234, deployed at 2026-11-15 10:00 (Asia/Jakarta)"
    );
    expect(text).toContain(
      "legacy: repo acme/acme-membership, commit 1111111111, deployed but running commit unknown — reading branch release/kestrel head"
    );
    expect(text).toContain(
      "portal: repo acme/acme-membership, commit 2222222222, never deployed — reading branch kestrel/development head"
    );
    expect(text).toContain(
      "cms: repo acme/acme-membership, no commit, unavailable: no-credentials"
    );
    expect(text).not.toContain("No source code is available");
  });

  it("states the branch read for each component of the project branches", () => {
    const text = projectNote([
      { ...PROJECT_SOURCE, commitSha: "3333333333dddd" },
      {
        ...PROJECT_SOURCE,
        componentKey: "portal",
        ciConnectionId: null,
        unavailableReason: "no-connection",
      },
    ]);
    expect(text).toContain("Source: project branches");
    expect(text).not.toContain("Environment:");
    expect(text).toContain(
      "- backend: repo acme/acme-membership, commit 3333333333, branch kestrel/development head"
    );
    expect(text).toContain(
      "- portal: repo acme/acme-membership, no commit, unavailable: no-connection"
    );
  });

  it("says when no source code can be read", () => {
    expect(projectNote([])).toContain("No source code is available");
    expect(projectNote([])).toContain(
      "this project has no components in its Sources"
    );
    expect(environmentNote([])).toContain(
      "this environment has no deploy targets with a source repository"
    );
  });

  it("guides a cheap search strategy and explains withheld files", () => {
    const text = prompt();
    expect(text).toContain("targeted search_code using a specific glob");
    expect(text).toContain("**/*Iuran*.java");
    expect(text).toContain("never list `**/*` across the whole repository");
    expect(text).toContain("read only the line ranges you need");
    expect(text).toContain("stop exploring once the answer is supported");
    expect(text).toContain("A withheld file exists; it is not missing.");
  });

  it("keeps only the date in the volatile system message", () => {
    expect(buildVolatileSystemNote(new Date("2026-11-16T05:00:00.000Z"))).toBe(
      "Today's date is 2026-11-16 (Asia/Jakarta)."
    );
  });

  it("is stable for the same inputs", () => {
    expect(prompt()).toBe(prompt());
  });
});
