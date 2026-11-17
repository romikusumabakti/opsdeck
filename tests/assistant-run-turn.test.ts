import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaRawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
      state.toolCalls.push({ tool, input, resultMeta });
    }
  ),
}));

const {
  runTurn,
  classifyError,
  MAX_ITERATIONS,
  STEP_LIMIT_NOTE,
  DAILY_CAP_NOTE,
  toToolResult,
  echoContent,
} = await import("@/lib/assistant/run-turn");
const { buildSystemPrompt } = await import("@/lib/assistant/system-prompt");
const { SnapshotUnavailableError } = await import("@/lib/assistant/snapshot");

// --- scripted fake Anthropic client ------------------------------------------

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

const USAGE: Usage = {
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_input_tokens: 5000,
  cache_creation_input_tokens: 2000,
};

type Step =
  | {
      text?: string[];
      content: BetaContentBlock[];
      stop_reason: BetaMessage["stop_reason"];
      model?: string;
    }
  | { text?: string[]; error: unknown; partialUsage?: Usage };

function finalMessage(step: Extract<Step, { content: unknown }>): BetaMessage {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: step.model ?? "claude-opus-5-5",
    content: step.content,
    stop_reason: step.stop_reason,
    stop_sequence: null,
    usage: { ...USAGE },
  } as unknown as BetaMessage;
}

function fakeClient(steps: Step[]) {
  const requests: Array<Record<string, unknown>> = [];
  const stream = vi.fn((params: Record<string, unknown>) => {
    requests.push(params);
    const step = steps.shift();
    if (!step) throw new Error("no scripted step left");
    const events: BetaRawMessageStreamEvent[] = (step.text ?? []).map(
      (text) =>
        ({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        }) as BetaRawMessageStreamEvent
    );
    return {
      get currentMessage() {
        return "error" in step && step.partialUsage
          ? { model: "claude-opus-5-5", usage: step.partialUsage }
          : undefined;
      },
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
        if ("error" in step) throw step.error;
      },
      finalMessage: async () => {
        if ("error" in step) throw step.error;
        return finalMessage(step);
      },
    };
  });
  const client = { beta: { messages: { stream } } } as unknown as Anthropic;
  return { client, requests, stream };
}

const text = (t: string) =>
  ({ type: "text", text: t, citations: null }) as unknown as BetaContentBlock;
const toolUse = (id: string, name: string, input: unknown) =>
  ({ type: "tool_use", id, name, input }) as unknown as BetaContentBlock;
const thinking = (signature: string) =>
  ({
    type: "thinking",
    thinking: "",
    signature,
  }) as unknown as BetaContentBlock;

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

function baseTurn(): TurnContext {
  return {
    messageId: MESSAGE_ID,
    status: "queued",
    content: "",
    conversationId: "conv-1",
    userId: USER_ID,
    userName: "Widya",
    projectName: "Kestrel Membership",
    environmentId: "env-1",
    environmentName: "Dev 1",
    history: [
      { role: "user", content: "Bagaimana Iuran dihitung?", status: "done" },
    ],
    attachmentIds: [],
  };
}

function deps(
  client: Anthropic,
  overrides: Record<string, unknown> = {}
): Parameters<typeof runTurn>[1] {
  let clock = Date.parse("2026-11-16T05:00:00.000Z");
  return {
    client,
    // Each read advances 500 ms, so every delta passes the flush throttle.
    now: () => {
      clock += 500;
      return new Date(clock);
    },
    loadRuntime: async () => ({
      client,
      model: "claude-opus-5-5",
      effort: "medium",
      dailyCapUsd: 1.5,
    }),
    loadViewer: async () => ({
      userId: USER_ID,
      orgRole: "qa",
      projectIds: ["p1"],
      canManageKnowledge: false,
    }),
    spentToday: async () => 0,
    resolveSources: async () => [SOURCE],
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
  state.usage = [];
});

// One response's cost at Opus 5.5 prices (4 / 20 / 0.20 / 5 per MTok).
const ONE_RESPONSE_USD =
  (1000 * 4 + 200 * 20 + 5000 * 0.2 + 2000 * 5) / 1_000_000;

describe("runTurn", () => {
  it("runs a tool call and ends done with the final text", async () => {
    const { client, requests } = fakeClient([
      {
        content: [
          thinking("sig-1"),
          toolUse("tu_1", "search_code", { pattern: "hitungIuran" }),
        ],
        stop_reason: "tool_use",
      },
      {
        text: ["Iuran dihitung ", "di `backend/src/Iuran.java:42`."],
        content: [text("Iuran dihitung di `backend/src/Iuran.java:42`.")],
        stop_reason: "end_turn",
      },
    ]);

    await runTurn(MESSAGE_ID, deps(client));

    expect(state.message.status).toBe("done");
    expect(state.message.content).toBe(
      "Iuran dihitung di `backend/src/Iuran.java:42`."
    );
    expect(state.message.errorCode).toBeNull();
    expect(state.contentWrites.length).toBeGreaterThan(0);

    expect(state.toolCalls).toEqual([
      {
        tool: "search_code",
        input: { pattern: "hitungIuran" },
        resultMeta: { paths: ["backend/src/Iuran.java"] },
      },
    ]);

    expect(state.usage).toHaveLength(2);
    const total = state.usage.reduce((s, r) => s + Number(r.costUsd), 0);
    expect(total).toBeCloseTo(2 * ONE_RESPONSE_USD, 6);
    expect(state.usage[0]).toMatchObject({
      messageId: MESSAGE_ID,
      userId: USER_ID,
      model: "claude-opus-5-5",
      inputTokens: 1000,
      cacheReadTokens: 5000,
      cacheWriteTokens: 2000,
      outputTokens: 200,
      day: "2026-11-16",
    });

    // The second request carries the first response unchanged (thinking
    // included) and the tool result in one user message.
    const second = requests[1] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(second.messages.at(-2)).toEqual({
      role: "assistant",
      content: [
        thinking("sig-1"),
        toolUse("tu_1", "search_code", { pattern: "hitungIuran" }),
      ],
    });
    expect(second.messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: JSON.stringify({
            matches: [{ path: "backend/src/Iuran.java", line: 42 }],
          }),
        },
      ],
    });
    expect(state.message.sources).toEqual([SOURCE]);
  });

  it("keeps only the final response's text in content (R11)", async () => {
    const { client } = fakeClient([
      {
        text: ["Saya cari dulu."],
        content: [
          text("Saya cari dulu."),
          toolUse("tu_1", "search_code", { pattern: "Iuran" }),
        ],
        stop_reason: "tool_use",
      },
      {
        text: ["Jawaban akhir."],
        content: [text("Jawaban akhir.")],
        stop_reason: "end_turn",
      },
    ]);
    await runTurn(MESSAGE_ID, deps(client));

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

  it("records the usage streamed before a mid-stream error", async () => {
    const overloaded = new Anthropic.APIError(
      undefined,
      {
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      },
      undefined,
      undefined,
      "overloaded_error"
    );
    const { client } = fakeClient([
      {
        text: ["Sebagian"],
        error: overloaded,
        partialUsage: { ...USAGE, output_tokens: 50 },
      },
    ]);
    await runTurn(MESSAGE_ID, deps(client));

    expect(state.message.errorCode).toBe("assistant.unavailable");
    expect(state.message.content).toBe("Sebagian");
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({
      outputTokens: 50,
      model: "claude-opus-5-5",
    });
    expect(Number(state.usage[0]?.costUsd)).toBeCloseTo(
      (1000 * 4 + 50 * 20 + 5000 * 0.2 + 2000 * 5) / 1_000_000,
      6
    );
  });

  it("leaves output_config out for an effort the SDK does not know", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, requests } = fakeClient([
      { content: [text("ok")], stop_reason: "end_turn" },
    ]);
    await runTurn(
      MESSAGE_ID,
      deps(client, {
        loadRuntime: async () => ({
          client,
          model: "claude-opus-5-5",
          effort: "turbo",
          dailyCapUsd: 1.5,
        }),
      })
    );
    expect(requests[0]).not.toHaveProperty("output_config");
    warn.mockRestore();
  });

  it("sends auto tool choice, adaptive thinking, the configured effort and the refusal fallback", async () => {
    const { client, requests } = fakeClient([
      { text: ["Halo"], content: [text("Halo")], stop_reason: "end_turn" },
    ]);
    await runTurn(MESSAGE_ID, deps(client));

    type Sent = {
      tool_choice: unknown;
      thinking?: { type: string };
      output_config: { effort: string };
      model: string;
      max_tokens: number;
      betas: string[];
      fallbacks: unknown;
      tools: Array<{ cache_control?: unknown }>;
      system: Array<{ text: string; cache_control?: unknown }>;
      messages: unknown[];
    };
    const request = requests[0] as unknown as Sent;
    expect(request.tool_choice).toEqual({ type: "auto" });
    expect(request).not.toHaveProperty("temperature");
    expect(
      request.thinking === undefined || request.thinking.type === "adaptive"
    ).toBe(true);
    expect(request.output_config.effort).toBe("medium");
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.max_tokens).toBe(32000);
    expect(request.betas).toContain("server-side-fallback-2026-07-01");
    expect(request.fallbacks).toBe("default");
    // Cache breakpoints: last tool and the stable system block.
    expect(request.tools.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(request.tools.slice(0, -1).some((t) => t.cache_control)).toBe(false);
    expect(request.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(request.system[0]?.text).not.toContain("2026-11-16");
    expect(request.system[1]?.text).toContain("2026-11-16");
    expect(request.messages).toEqual([
      { role: "user", content: "Bagaimana Iuran dihitung?" },
    ]);
  });

  it("fails with credit_exhausted on a billing error and keeps the partial text", async () => {
    const billing = Anthropic.APIError.generate(
      400,
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message:
            "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
        },
      },
      undefined,
      new Headers()
    );
    const { client, stream } = fakeClient([
      { text: ["Sebagian ", "jawaban"], error: billing },
    ]);

    await runTurn(MESSAGE_ID, deps(client));

    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.credit_exhausted");
    expect(state.message.content).toBe("Sebagian jawaban");
    // No retry storm: one request, no further attempts.
    expect(stream).toHaveBeenCalledTimes(1);
    expect(state.usage).toHaveLength(0);
  });

  it("sends the last allowed request with tool_choice none and the step-limit note, and keeps its answer", async () => {
    const steps: Step[] = Array.from(
      { length: MAX_ITERATIONS - 1 },
      (_, i) => ({
        content: [toolUse(`tu_${i}`, "list_files", { glob: "**/*" })],
        stop_reason: "tool_use" as const,
      })
    );
    steps.push({
      text: ["Temuan sejauh ini: ..."],
      content: [text("Temuan sejauh ini: ...")],
      stop_reason: "end_turn",
    });
    const { client, requests } = fakeClient(steps);

    await runTurn(MESSAGE_ID, deps(client));

    expect(requests).toHaveLength(MAX_ITERATIONS);
    type Sent = {
      tool_choice: unknown;
      tools: unknown[];
      messages: Array<{ role: string; content: unknown }>;
    };
    const sent = requests as unknown as Sent[];
    expect(sent.slice(0, -1).map((r) => r.tool_choice)).toEqual(
      Array(MAX_ITERATIONS - 1).fill({ type: "auto" })
    );
    const last = sent.at(-1)!;
    expect(last.tool_choice).toEqual({ type: "none" });
    // Same tools array, so the cached tools + system prefix still holds.
    expect(last.tools).toEqual(sent[0]?.tools);
    const lastUser = last.messages.at(-1);
    expect(lastUser?.role).toBe("user");
    const blocks = lastUser?.content as Array<{ type: string; text?: string }>;
    expect(blocks.slice(0, -1).every((b) => b.type === "tool_result")).toBe(
      true
    );
    expect(blocks.at(-1)).toEqual({ type: "text", text: STEP_LIMIT_NOTE });
    // Only the results before the last request carry the note.
    const earlier = sent.at(-2)?.messages.at(-1)?.content as Array<{
      type: string;
    }>;
    expect(earlier.every((b) => b.type === "tool_result")).toBe(true);

    expect(state.message.status).toBe("done");
    expect(state.message.content).toBe("Temuan sejauh ini: ...");
  });

  it("fails with daily_cap_reached before any request once the cap is spent", async () => {
    const { client, stream } = fakeClient([]);
    await runTurn(MESSAGE_ID, deps(client, { spentToday: async () => 1.5 }));
    expect(stream).not.toHaveBeenCalled();
    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.daily_cap_reached");
  });

  it("re-checks the cap before each request and sends one final answer-only request once it is reached", async () => {
    const { client, stream, requests } = fakeClient([
      {
        content: [toolUse("tu_1", "list_files", { glob: "**/*" })],
        stop_reason: "tool_use",
      },
      {
        text: ["Jawaban dengan temuan yang ada"],
        content: [text("Jawaban dengan temuan yang ada")],
        stop_reason: "end_turn",
      },
    ]);
    // Under the cap at the start; over it once the first response is metered.
    const spentToday = vi.fn(async () =>
      state.usage.reduce((sum, row) => sum + Number(row.costUsd), 1.49)
    );
    await runTurn(MESSAGE_ID, deps(client, { spentToday }));
    expect(stream).toHaveBeenCalledTimes(2);
    expect(spentToday).toHaveBeenCalledTimes(2);
    expect(spentToday).toHaveBeenCalledWith(USER_ID, expect.any(Date));
    type Sent = {
      tool_choice: unknown;
      tools: unknown[];
      messages: Array<{ role: string; content: unknown }>;
    };
    const sent = requests as unknown as Sent[];
    expect(sent[0]?.tool_choice).toEqual({ type: "auto" });
    expect(sent[1]?.tool_choice).toEqual({ type: "none" });
    expect(sent[1]?.tools).toEqual(sent[0]?.tools);
    const blocks = sent[1]?.messages.at(-1)?.content as Array<{
      type: string;
      text?: string;
    }>;
    expect(blocks[0]?.type).toBe("tool_result");
    expect(blocks.at(-1)).toEqual({ type: "text", text: DAILY_CAP_NOTE });
    expect(state.toolCalls).toHaveLength(1);
    // Both requests are metered.
    expect(state.usage).toHaveLength(2);
    expect(state.message.status).toBe("done");
    expect(state.message.content).toBe("Jawaban dengan temuan yang ada");
  });

  it("fails with daily_cap_reached when the final capped request still asks for tools", async () => {
    const { client, stream } = fakeClient([
      {
        content: [toolUse("tu_1", "list_files", { glob: "**/*" })],
        stop_reason: "tool_use",
      },
      {
        content: [toolUse("tu_2", "list_files", { glob: "**/*" })],
        stop_reason: "tool_use",
      },
      { content: [text("never sent")], stop_reason: "end_turn" },
    ]);
    const spentToday = vi.fn(async () =>
      state.usage.reduce((sum, row) => sum + Number(row.costUsd), 1.49)
    );
    await runTurn(MESSAGE_ID, deps(client, { spentToday }));
    expect(stream).toHaveBeenCalledTimes(2);
    expect(state.toolCalls).toHaveLength(1);
    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.daily_cap_reached");
  });

  it("never sends more than one request past the cap (pause_turn on the final request)", async () => {
    const { client, stream } = fakeClient([
      {
        content: [toolUse("tu_1", "list_files", { glob: "**/*" })],
        stop_reason: "tool_use",
      },
      { content: [text("jeda")], stop_reason: "pause_turn" },
      { content: [text("never sent")], stop_reason: "end_turn" },
    ]);
    const spentToday = vi.fn(async () =>
      state.usage.reduce((sum, row) => sum + Number(row.costUsd), 1.49)
    );
    await runTurn(MESSAGE_ID, deps(client, { spentToday }));
    expect(stream).toHaveBeenCalledTimes(2);
    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.daily_cap_reached");
  });

  it("stops after 25 requests and fails with too_many_steps", async () => {
    const steps: Step[] = Array.from(
      { length: MAX_ITERATIONS + 1 },
      (_, i) => ({
        content: [toolUse(`tu_${i}`, "list_files", { glob: "**/*" })],
        stop_reason: "tool_use" as const,
      })
    );
    const { client, stream } = fakeClient(steps);

    await runTurn(MESSAGE_ID, deps(client));

    expect(stream).toHaveBeenCalledTimes(MAX_ITERATIONS);
    expect(state.toolCalls).toHaveLength(MAX_ITERATIONS - 1);
    expect(state.usage).toHaveLength(MAX_ITERATIONS);
    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.too_many_steps");
    expect(state.message.content).toBe("");
  });

  it("fails with not_configured when the runtime is missing or its key cannot be decrypted", async () => {
    const { client, stream } = fakeClient([]);
    await runTurn(MESSAGE_ID, deps(client, { loadRuntime: async () => null }));
    expect(state.message.errorCode).toBe("assistant.not_configured");

    state.message = {
      status: "queued",
      content: "",
      errorCode: null,
      sources: null,
    };
    await runTurn(
      MESSAGE_ID,
      deps(client, {
        loadRuntime: async () => {
          throw new Error("Unsupported state or unable to authenticate data");
        },
      })
    );
    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.not_configured");
    expect(stream).not.toHaveBeenCalled();
  });

  it("fails with refused when the whole fallback chain refuses", async () => {
    const { client } = fakeClient([
      { text: ["Mulai"], content: [text("Mulai")], stop_reason: "refusal" },
    ]);
    await runTurn(MESSAGE_ID, deps(client));
    expect(state.message.errorCode).toBe("assistant.refused");
    expect(state.message.content).toBe("Mulai");
    expect(state.usage).toHaveLength(1);
  });

  it("prices a response by the model it reports, falling back to the configured prices for unknown models", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = fakeClient([
      {
        content: [text("ok")],
        stop_reason: "end_turn",
        model: "claude-future-9",
      },
    ]);
    await runTurn(MESSAGE_ID, deps(client));
    expect(state.message.status).toBe("done");
    expect(state.usage[0]?.model).toBe("claude-future-9");
    expect(Number(state.usage[0]?.costUsd)).toBeCloseTo(ONE_RESPONSE_USD, 6);
    warn.mockRestore();
  });

  it("names unavailable components and still runs the turn", async () => {
    const { client, requests } = fakeClient([
      { content: [text("ok")], stop_reason: "end_turn" },
    ]);
    await runTurn(
      MESSAGE_ID,
      deps(client, {
        ensureSnapshot: async () => {
          throw new SnapshotUnavailableError("unsupported-forge");
        },
      })
    );
    const system = (requests[0] as { system: Array<{ text: string }> }).system;
    expect(system[0]?.text).toContain("unavailable: unsupported-forge");
    expect(system[0]?.text).toContain("No source code is available");
    expect(state.message.status).toBe("done");
    expect(state.message.sources).toEqual([{ ...SOURCE, commitSha: null }]);
  });

  it("rebuilds the history as text and skips empty failed answers", async () => {
    state.turn = {
      ...baseTurn(),
      history: [
        { role: "user", content: "Q1", status: "done" },
        { role: "assistant", content: "A1", status: "done" },
        { role: "user", content: "Q2", status: "done" },
        { role: "assistant", content: "", status: "failed" },
        { role: "user", content: "Q3", status: "done" },
      ],
      // A malformed (pre-pair) entry is dropped.
      attachmentIds: ["KST-12:10001", "10002"],
    };
    const { client, requests } = fakeClient([
      { content: [text("A3")], stop_reason: "end_turn" },
    ]);
    await runTurn(MESSAGE_ID, deps(client));
    const messages = (requests[0] as { messages: unknown[] }).messages;
    expect(messages).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
      {
        role: "user",
        content:
          "Q3\n\n(Attachments ticked for this question, readable with read_attachment:\n- issue_key KST-12, attachment_id 10001)",
      },
    ]);
  });

  it("fails a redelivered turn that was already streaming as interrupted", async () => {
    state.turn = { ...baseTurn(), status: "streaming", content: "Sebagian" };
    state.message.status = "streaming";
    const { client, stream } = fakeClient([]);
    await runTurn(MESSAGE_ID, deps(client));
    expect(stream).not.toHaveBeenCalled();
    expect(state.message.status).toBe("failed");
    expect(state.message.errorCode).toBe("assistant.interrupted");
    expect(state.message.content).toBe("Sebagian");
  });

  it("does nothing for a turn that is already finished", async () => {
    state.turn = { ...baseTurn(), status: "done" };
    state.message.status = "done";
    const { client, stream } = fakeClient([]);
    await runTurn(MESSAGE_ID, deps(client));
    expect(stream).not.toHaveBeenCalled();
    expect(state.message.status).toBe("done");
  });
});

describe("classifyError", () => {
  const generate = (status: number | undefined, type: string, message = "x") =>
    Anthropic.APIError.generate(
      status,
      { type: "error", error: { type, message } },
      undefined,
      new Headers()
    );

  it("maps SDK errors to stable codes", () => {
    expect(classifyError(generate(402, "billing_error"))).toBe(
      "assistant.credit_exhausted"
    );
    expect(classifyError(generate(401, "authentication_error"))).toBe(
      "assistant.not_configured"
    );
    expect(classifyError(generate(429, "rate_limit_error"))).toBe(
      "assistant.unavailable"
    );
    expect(classifyError(generate(529, "overloaded_error"))).toBe(
      "assistant.unavailable"
    );
    expect(classifyError(generate(500, "api_error"))).toBe(
      "assistant.unavailable"
    );
    expect(
      classifyError(new Anthropic.APIConnectionError({ message: "x" }))
    ).toBe("assistant.unavailable");
    // A mid-stream SSE error has a type but no status.
    expect(
      classifyError(
        new Anthropic.APIError(
          undefined,
          { type: "error", error: { type: "overloaded_error" } },
          undefined,
          undefined,
          "overloaded_error"
        )
      )
    ).toBe("assistant.unavailable");
    expect(classifyError(generate(400, "invalid_request_error", "bad"))).toBe(
      "assistant.failed"
    );
    expect(classifyError(new Error("boom"))).toBe("assistant.failed");
  });
});

describe("tool results", () => {
  it("turns attachments into document, image and text blocks and errors into is_error", () => {
    expect(
      toToolResult("read_attachment", "t", {
        ok: true,
        data: {
          kind: "document",
          mediaType: "application/pdf",
          base64: "UERG",
        },
        meta: {},
      }).content
    ).toEqual([
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "UERG" },
      },
    ]);
    expect(
      toToolResult("read_attachment", "t", {
        ok: true,
        data: { kind: "image", mediaType: "image/png", base64: "iVBO" },
        meta: {},
      }).content
    ).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "iVBO" },
      },
    ]);
    expect(
      toToolResult("read_attachment", "t", {
        ok: true,
        data: { kind: "text", text: "a,b" },
        meta: {},
      }).content
    ).toEqual([{ type: "text", text: "a,b" }]);
    expect(
      toToolResult("get_issue", "t", {
        ok: false,
        error: "not found",
        meta: {},
      })
    ).toEqual({
      type: "tool_result",
      tool_use_id: "t",
      is_error: true,
      content: "not found",
    });
  });

  it("sends other tools' data as JSON even when it has a kind field", () => {
    const data = { kind: "text", text: "not an attachment" };
    expect(
      toToolResult("read_knowledge", "t", { ok: true, data, meta: {} }).content
    ).toBe(JSON.stringify(data));
  });

  it("drops the declined attempt's thinking and tool calls before a fallback block", () => {
    const fallback = {
      type: "fallback",
      from: { model: "claude-opus-5-5" },
      to: { model: "claude-opus-4-8" },
    } as unknown as BetaContentBlock;
    expect(
      echoContent([
        thinking("old"),
        text("partial"),
        toolUse("x", "list_files", {}),
        fallback,
        thinking("new"),
        toolUse("y", "list_files", {}),
      ])
    ).toEqual([
      text("partial"),
      fallback,
      thinking("new"),
      toolUse("y", "list_files", {}),
    ]);
  });
});

describe("buildSystemPrompt", () => {
  const prompt = (
    sources: Parameters<typeof buildSystemPrompt>[0]["sources"]
  ) =>
    buildSystemPrompt({
      projectName: "Kestrel Membership",
      environmentName: "Dev 1",
      userName: "Widya",
      sources,
    });

  it("states each component's source state", () => {
    const text = prompt([
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
    expect(text).toContain("Project: Kestrel Membership");
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
    expect(text).toContain("tidak ditemukan di kode");
    expect(text).toContain("Yang dilakukan kode");
    expect(text).toContain("Asumsi");
    expect(text).toContain("Indonesian");
    expect(text).toContain("component/path:line");
    expect(text).not.toContain("No source code is available");
  });

  it("guides a cheap search strategy and explains withheld files", () => {
    const text = prompt([SOURCE]);
    expect(text).toContain("targeted search_code using a specific glob");
    expect(text).toContain("**/*Iuran*.java");
    expect(text).toContain("never list `**/*` across the whole repository");
    expect(text).toContain("read only the line ranges you need");
    expect(text).toContain("stop exploring once the answer is supported");
    expect(text).toContain("A withheld file exists; it is not missing.");
  });

  it("is stable for the same inputs", () => {
    expect(prompt([SOURCE])).toBe(prompt([SOURCE]));
  });
});
