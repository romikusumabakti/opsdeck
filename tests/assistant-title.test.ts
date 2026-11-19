import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The auto title (lib/assistant/title.ts) over a mocked store, usage and
// model: no provider is ever called.

const QUESTION = "Kapan batch rekonsiliasi iuran berjalan setiap bulan?";
const ANSWER = "Batch rekonsiliasi berjalan setiap tanggal 1 pukul 02:00.";

const state = vi.hoisted(() => ({
  input: null as null | {
    userId: string;
    question: string;
    answer: string;
    answerMessageId: string;
  },
  saved: [] as { conversationId: string; title: string }[],
  usage: [] as Record<string, unknown>[],
  spent: 0,
}));

vi.mock("@/lib/assistant/conversation-store", () => ({
  TITLE_MAX_CHARS: 80,
  loadTitleInput: vi.fn(async () => state.input),
  saveGeneratedTitle: vi.fn(async (conversationId: string, title: string) => {
    state.saved.push({ conversationId, title });
    return true;
  }),
}));

vi.mock("@/lib/assistant/usage", () => ({
  recordUsage: vi.fn(async (row: Record<string, unknown>) => {
    state.usage.push(row);
    return 0;
  }),
  spentTodayUsd: vi.fn(async () => state.spent),
}));

const { generateConversationTitle, cleanTitle } = await import(
  "@/lib/assistant/title"
);

const CHAT = "0197f3a0-1b2c-7def-8000-0000000c0001";

function textModel(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop", raw: undefined } as const,
      usage: {
        inputTokens: {
          total: 120,
          noCache: 120,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 6, text: 6, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

function runtime(model: MockLanguageModelV4) {
  return {
    model,
    provider: "openai-compatible" as const,
    modelId: "title-model",
    prices: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    dailyCapUsd: 1.5,
  };
}

beforeEach(() => {
  state.input = {
    userId: "user-1",
    question: QUESTION,
    answer: ANSWER,
    answerMessageId: "answer-1",
  };
  state.saved = [];
  state.usage = [];
  state.spent = 0;
});

describe("generateConversationTitle", () => {
  it("saves a short title from the question and the answer start, metered", async () => {
    const model = textModel('"Jadwal Batch Rekonsiliasi Iuran Bulanan."');
    expect(
      await generateConversationTitle(CHAT, {
        loadRuntime: async () => runtime(model),
      })
    ).toBe("generated");
    expect(state.saved).toEqual([
      {
        conversationId: CHAT,
        title: "Jadwal Batch Rekonsiliasi Iuran Bulanan",
      },
    ]);
    // The prompt carries the question and the answer, and asks for the
    // question's language.
    const [call] = model.doGenerateCalls;
    const prompt = JSON.stringify(call?.prompt);
    expect(prompt).toContain("rekonsiliasi iuran berjalan");
    expect(prompt).toContain("tanggal 1 pukul 02:00");
    expect(prompt).toMatch(/language/i);
    // Recorded like any call, at the title model's prices, with no message.
    expect(state.usage).toEqual([
      expect.objectContaining({
        messageId: null,
        userId: "user-1",
        modelId: "title-model",
        prices: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
        usage: { input: 120, cacheRead: 0, cacheWrite: 0, output: 6 },
        estimated: false,
      }),
    ]);
  });

  it("does nothing when the store has no title to make (renamed, temporary, generated)", async () => {
    state.input = null;
    const model = textModel("Judul");
    expect(
      await generateConversationTitle(CHAT, {
        loadRuntime: async () => runtime(model),
      })
    ).toBe("skipped");
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(state.saved).toEqual([]);
    expect(state.usage).toEqual([]);
  });

  it("keeps the first-message title when the call fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("provider down");
      },
    });
    expect(
      await generateConversationTitle(CHAT, {
        loadRuntime: async () => runtime(model),
      })
    ).toBe("failed");
    expect(state.saved).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps the title when the model answers nothing usable", async () => {
    const model = textModel('  "" ');
    expect(
      await generateConversationTitle(CHAT, {
        loadRuntime: async () => runtime(model),
      })
    ).toBe("failed");
    expect(state.saved).toEqual([]);
    // The call still cost tokens.
    expect(state.usage).toHaveLength(1);
  });

  it("skips without a usable runtime or once the day's cap is spent", async () => {
    expect(
      await generateConversationTitle(CHAT, { loadRuntime: async () => null })
    ).toBe("skipped");
    state.spent = 1.5;
    const model = textModel("Judul");
    expect(
      await generateConversationTitle(CHAT, {
        loadRuntime: async () => runtime(model),
      })
    ).toBe("skipped");
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});

describe("cleanTitle", () => {
  it("keeps at most six words on one line, without quotes or a final stop", () => {
    expect(cleanTitle("Title: Satu dua tiga empat lima enam tujuh")).toBe(
      "Satu dua tiga empat lima enam"
    );
    expect(cleanTitle("“Jadwal batch”\nalasan: ...")).toBe("Jadwal batch");
    expect(cleanTitle("**Status server staging**.")).toBe(
      "Status server staging"
    );
    expect(cleanTitle("服务器状态检查")).toBe("服务器状态检查");
    expect(cleanTitle("   ")).toBeNull();
    expect(Array.from(cleanTitle("x".repeat(200)) ?? "")).toHaveLength(80);
  });
});
