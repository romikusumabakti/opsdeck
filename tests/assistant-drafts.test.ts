import type Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantRuntime } from "@/lib/assistant/client";
import type { DraftTranscript } from "@/lib/assistant/draft-store";

// generateDraft: one structured-output Messages request (no tools) over the
// conversation's text turns, metered, stop reason checked before parsing.

const state = vi.hoisted(() => ({
  transcript: null as DraftTranscript | null,
  drafts: [] as Array<{
    conversationId: string;
    kind: string;
    content: unknown;
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

vi.mock("@/lib/assistant/draft-store", () => ({
  loadDraftTranscript: vi.fn(async () => state.transcript),
  insertDraft: vi.fn(
    async (v: { conversationId: string; kind: string; content: unknown }) => {
      state.drafts.push(v);
      return "draft-1";
    }
  ),
}));

const {
  generateDraft,
  buildDraftSystemPrompt,
  BRD_SECTION_HEADINGS,
  JIRA_SUMMARY_MAX,
  JIRA_CRITERIA_MAX,
  jiraDraftSchema,
} = await import("@/lib/assistant/drafts");
const { TurnError } = await import("@/lib/assistant/run-turn");

const USAGE = {
  input_tokens: 3000,
  output_tokens: 800,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

const text = (t: string) =>
  ({ type: "text", text: t, citations: null }) as unknown as BetaContentBlock;

function fakeRuntime(
  content: BetaContentBlock[],
  stop: BetaMessage["stop_reason"] = "end_turn"
) {
  const requests: Array<Record<string, unknown>> = [];
  const stream = vi.fn((params: Record<string, unknown>) => {
    requests.push(params);
    return {
      currentMessage: undefined,
      async *[Symbol.asyncIterator]() {},
      finalMessage: async () =>
        ({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content,
          stop_reason: stop,
          stop_sequence: null,
          usage: { ...USAGE },
        }) as unknown as BetaMessage,
    };
  });
  const runtime: AssistantRuntime = {
    client: { beta: { messages: { stream } } } as unknown as Anthropic,
    model: "claude-opus-5-5",
    effort: "medium",
    dailyCapUsd: 1.5,
  };
  return { runtime, requests, stream };
}

const JIRA_JSON = {
  summary: "Perhitungan iuran tambahan dibulatkan ke bawah",
  issueType: "Bug",
  description:
    "Saat ini `IuranService.calculate` (backend/src/IuranService.java:42) membulatkan ke bawah.",
  acceptanceCriteria: [
    "Iuran tambahan dibulatkan ke atas ke rupiah terdekat",
    "Perlu konfirmasi BA: pembulatan untuk iuran awal",
  ],
};

beforeEach(() => {
  state.transcript = {
    projectName: "Membership",
    environmentName: "Dev 1",
    messages: [
      { role: "user", content: "Bagaimana iuran tambahan dihitung?" },
      {
        role: "assistant",
        content: "Dibulatkan ke bawah (IuranService.java:42).",
      },
    ],
  };
  state.drafts = [];
  state.usage = [];
});

describe("generateDraft request", () => {
  it("is one structured-output request without tools, metered, with the fallback and effort", async () => {
    const { runtime, requests } = fakeRuntime([
      text(JSON.stringify(JIRA_JSON)),
    ]);
    const result = await generateDraft("conv-1", "jira", "user-1", {
      runtime,
    });
    expect(result).toEqual({ draftId: "draft-1" });
    expect(requests).toHaveLength(1);
    const req = requests[0] ?? {};
    expect(req).not.toHaveProperty("tools");
    expect(req).not.toHaveProperty("tool_choice");
    expect(req).not.toHaveProperty("temperature");
    expect(req).not.toHaveProperty("cache_control");
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.max_tokens).toBe(32_000);
    expect(req.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(req.fallbacks).toBe("default");
    expect(req.thinking).toEqual({ type: "adaptive" });
    const config = req.output_config as {
      effort: string;
      format: { type: string; schema: { properties: object }; parse?: unknown };
    };
    expect(config.effort).toBe("medium");
    expect(config.format.type).toBe("json_schema");
    expect(Object.keys(config.format.schema.properties)).toEqual([
      "summary",
      "issueType",
      "description",
      "acceptanceCriteria",
    ]);
    expect(config.format).not.toHaveProperty("parse");
    const system = req.system as Array<{
      text: string;
      cache_control?: object;
    }>;
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]?.text).toContain("Indonesian");
    expect(system[0]?.text).toContain("Perlu konfirmasi BA");
    const messages = req.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain(
      "<user>\nBagaimana iuran tambahan dihitung?\n</user>"
    );
    expect(messages[0]?.content).toContain("IuranService.java:42");

    expect(state.drafts).toEqual([
      { conversationId: "conv-1", kind: "jira", content: JIRA_JSON },
    ]);
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({
      messageId: null,
      userId: "user-1",
      model: "claude-opus-5-5",
      inputTokens: 3000,
      outputTokens: 800,
    });
  });

  it("asks for the BRD outline headings and stores the BRD", async () => {
    const brd = {
      title: "Iuran Tambahan",
      sections: [{ heading: "Business Process", body: "Alur saat ini." }],
    };
    const { runtime, requests } = fakeRuntime([text(JSON.stringify(brd))]);
    await generateDraft("conv-1", "brd", "user-1", { runtime });
    const system = ((requests[0]?.system ?? []) as Array<{ text: string }>)[0]
      ?.text;
    for (const heading of BRD_SECTION_HEADINGS) {
      expect(system).toContain(heading);
    }
    expect(state.drafts[0]).toEqual({
      conversationId: "conv-1",
      kind: "brd",
      content: brd,
    });
  });

  it("joins the text blocks around a mid-output refusal fallback", async () => {
    const json = JSON.stringify(JIRA_JSON);
    const { runtime } = fakeRuntime([
      text(json.slice(0, 20)),
      { type: "fallback" } as unknown as BetaContentBlock,
      text(json.slice(20)),
    ]);
    await generateDraft("conv-1", "jira", "user-1", { runtime });
    expect(state.drafts[0]?.content).toEqual(JIRA_JSON);
  });

  it("cuts an over-long draft to the stored limits", async () => {
    const { runtime } = fakeRuntime([
      text(
        JSON.stringify({
          ...JIRA_JSON,
          summary: "x".repeat(400),
          acceptanceCriteria: Array.from({ length: 30 }, (_, i) => `AC ${i}`),
        })
      ),
    ]);
    await generateDraft("conv-1", "jira", "user-1", { runtime });
    const content = state.drafts[0]?.content as {
      summary: string;
      acceptanceCriteria: string[];
    };
    expect(content.summary).toHaveLength(JIRA_SUMMARY_MAX);
    expect(content.acceptanceCriteria).toHaveLength(JIRA_CRITERIA_MAX);
    expect(jiraDraftSchema.safeParse(content).success).toBe(true);
  });
});

describe("generateDraft failures", () => {
  it("a refusal is assistant.refused, still metered, nothing stored", async () => {
    const { runtime } = fakeRuntime([text('{"summ')], "refusal");
    await expect(
      generateDraft("conv-1", "jira", "user-1", { runtime })
    ).rejects.toMatchObject({ code: "assistant.refused" });
    expect(state.usage).toHaveLength(1);
    expect(state.drafts).toEqual([]);
  });

  it("a truncated answer (max_tokens) is assistant.failed before any parse", async () => {
    const { runtime } = fakeRuntime(
      [text('{"summary": "Perhit')],
      "max_tokens"
    );
    const error = await generateDraft("conv-1", "jira", "user-1", {
      runtime,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TurnError);
    expect(error).toMatchObject({ code: "assistant.failed" });
    expect(state.drafts).toEqual([]);
  });

  it("output that does not match the schema is assistant.failed", async () => {
    const { runtime } = fakeRuntime([
      text(JSON.stringify({ ...JIRA_JSON, issueType: "Epic" })),
    ]);
    await expect(
      generateDraft("conv-1", "jira", "user-1", { runtime })
    ).rejects.toMatchObject({ code: "assistant.failed" });
    expect(state.drafts).toEqual([]);
  });

  it("a conversation without a finished answer is assistant.nothing_to_draft, with no request", async () => {
    state.transcript = {
      projectName: "Membership",
      environmentName: "Dev 1",
      messages: [{ role: "user", content: "Halo" }],
    };
    const { runtime, stream } = fakeRuntime([]);
    await expect(
      generateDraft("conv-1", "brd", "user-1", { runtime })
    ).rejects.toMatchObject({ code: "assistant.nothing_to_draft" });
    expect(stream).not.toHaveBeenCalled();
    expect(state.usage).toEqual([]);
  });
});

describe("draft prompts", () => {
  it("are English instructions that ask for Indonesian content", () => {
    for (const kind of ["brd", "jira"] as const) {
      const prompt = buildDraftSystemPrompt(kind);
      expect(prompt).toContain("Write the content in Indonesian");
      expect(prompt).toContain("Do not invent");
    }
  });
});
