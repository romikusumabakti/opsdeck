import {
  APICallError,
  simulateReadableStream,
  UnsupportedFunctionalityError,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantRuntime } from "@/lib/assistant/client";
import type { DraftTranscript } from "@/lib/assistant/draft-store";
import {
  cacheControlFor,
  outputTokenLimitFor,
  PROVIDERS,
  type Provider,
  providerOptionsFor,
} from "@/lib/assistant/providers";

// generateDraft: one structured-output request (no tools) over the
// conversation's text turns through the AI SDK, metered like a turn step,
// finish reason checked before parsing.

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
  brdDraftSchema,
} = await import("@/lib/assistant/drafts");
const { TurnError, classifyError } = await import("@/lib/assistant/run-turn");

type CallOptions = MockLanguageModelV4["doStreamCalls"][number];
type StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV4["doStream"]>
  >["stream"] extends ReadableStream<infer T>
    ? T
    : never;
type Usage = Extract<StreamPart, { type: "finish" }>["usage"];
type Finish = "stop" | "length" | "content-filter";

const USAGE: Usage = {
  inputTokens: { total: 3000, noCache: 3000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 800, text: 800, reasoning: undefined },
};
const NO_USAGE: Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

// Prices set apart from any list price, so the test proves they are used.
const PRICES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

type Reply =
  | { text: string[]; finish?: Finish; usage?: Usage }
  /** The request itself fails (an HTTP error). */
  | { error: unknown }
  /** The stream fails after `text` (an SSE error event). */
  | { text: string[]; streamError: unknown };

function chunksOf(reply: Reply): StreamPart[] {
  if ("error" in reply) return [];
  const chunks: StreamPart[] = [
    { type: "response-metadata", modelId: "served-model-1" },
    { type: "text-start", id: "t" },
    ...reply.text.map(
      (delta): StreamPart => ({ type: "text-delta", id: "t", delta })
    ),
  ];
  if ("streamError" in reply) {
    chunks.push({ type: "error", error: reply.streamError });
    return chunks;
  }
  const finish = reply.finish ?? "stop";
  chunks.push(
    { type: "text-end", id: "t" },
    {
      type: "finish",
      finishReason: { unified: finish, raw: finish },
      usage: reply.usage ?? USAGE,
    }
  );
  return chunks;
}

function mockModel(reply: Reply) {
  const model = new MockLanguageModelV4({
    provider: "mock.provider",
    modelId: "configured-model",
    doStream: async () => {
      if ("error" in reply) throw reply.error;
      return { stream: simulateReadableStream({ chunks: chunksOf(reply) }) };
    },
  });
  return { model, calls: model.doStreamCalls as CallOptions[] };
}

function runtime(overrides: Partial<AssistantRuntime> = {}): AssistantRuntime {
  return {
    // Replaced by the injected mock in every test.
    model: "unused-model-id",
    provider: "openai",
    modelId: "configured-model",
    effort: "medium",
    prices: PRICES,
    dailyCapUsd: 1.5,
    orgContext: null,
    ...overrides,
  };
}

async function draft(
  reply: Reply,
  kind: "jira" | "brd" = "jira",
  overrides: Partial<AssistantRuntime> = {}
) {
  const { model, calls } = mockModel(reply);
  const result = await generateDraft("conv-1", kind, "user-1", {
    runtime: runtime(overrides),
    model,
    projectId: "project-2",
  });
  return { result, calls };
}

async function draftError(reply: Reply, kind: "jira" | "brd" = "jira") {
  return draft(reply, kind).then(
    () => {
      throw new Error("expected the draft to fail");
    },
    (error: unknown) => error
  );
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

const json = (value: unknown) => {
  const text = JSON.stringify(value);
  // Two deltas, so the answer arrives in pieces like a real stream.
  return [text.slice(0, 20), text.slice(20)];
};

beforeEach(() => {
  state.transcript = {
    messages: [
      {
        role: "user",
        content: "Bagaimana iuran tambahan dihitung?",
        context: {
          kind: "environment",
          environmentId: "env-1",
          environmentName: "Dev 1",
          projectId: "project-1",
          projectName: "Membership",
        },
      },
      {
        role: "assistant",
        content: "Dibulatkan ke bawah (IuranService.java:42).",
      },
      {
        role: "user",
        content: "Dan di branch proyek?",
        context: {
          kind: "project",
          projectId: "project-1",
          projectName: "Membership",
        },
      },
      { role: "assistant", content: "Sama." },
      {
        role: "user",
        content: "Proyek mana yang menghitung manfaat?",
        context: { kind: "auto" },
      },
      { role: "assistant", content: "KST (BenefitService.java:10)." },
      {
        role: "user",
        content: "Dan di proyek lama?",
        context: { kind: "gone", of: "project", label: "Old Membership" },
      },
      {
        role: "user",
        content: "Dan di UAT lama?",
        context: { kind: "gone", of: "environment", label: "Old UAT" },
      },
    ],
  };
  state.drafts = [];
  state.usage = [];
});

describe("generateDraft request", () => {
  it("is one structured-output request without tools, metered at the configured prices", async () => {
    const { result, calls } = await draft({ text: json(JIRA_JSON) });
    expect(result).toEqual({ draftId: "draft-1" });
    expect(calls).toHaveLength(1);
    const call = calls[0] as CallOptions;
    expect(call.tools ?? []).toEqual([]);
    expect(call.temperature).toBeUndefined();
    expect(call.responseFormat?.type).toBe("json");
    const schema = (
      call.responseFormat as { schema: { properties: object } } | undefined
    )?.schema;
    expect(Object.keys(schema?.properties ?? {})).toEqual([
      "summary",
      "issueType",
      "description",
      "acceptanceCriteria",
    ]);
    const [system, user, ...rest] = call.prompt;
    expect(rest).toEqual([]);
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("Indonesian");
    expect(system?.content).toContain("Perlu konfirmasi BA");
    expect(user?.role).toBe("user");
    const userText = JSON.stringify(user?.content);
    expect(userText).toContain("<conversation>");
    expect(userText).not.toContain("Project:");
    // Each question names the context it was asked in.
    expect(userText).toContain(
      "<user>\\nContext: environment Dev 1 of project Membership\\nBagaimana iuran tambahan dihitung?\\n</user>"
    );
    expect(userText).toContain(
      "<user>\\nContext: project Membership (its branches)\\nDan di branch proyek?\\n</user>"
    );
    expect(userText).toContain(
      "<user>\\nContext: automatic (the assistant chose which project to read)\\nProyek mana yang menghitung manfaat?\\n</user>"
    );
    expect(userText).toContain(
      "<user>\\nContext: project Old Membership (deleted since)\\nDan di proyek lama?\\n</user>"
    );
    expect(userText).toContain(
      "<user>\\nContext: environment Old UAT (deleted since)\\nDan di UAT lama?\\n</user>"
    );
    expect(userText).not.toContain("project branches");
    expect(userText).toContain("IuranService.java:42");

    expect(state.drafts).toEqual([
      {
        conversationId: "conv-1",
        // The project the service chose (suggestDraftProject).
        projectId: "project-2",
        kind: "jira",
        content: JIRA_JSON,
      },
    ]);
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]).toMatchObject({
      messageId: null,
      userId: "user-1",
      model: "served-model-1",
      inputTokens: 3000,
      outputTokens: 800,
      estimated: false,
      // 3000 × 3 + 800 × 15 per million.
      costUsd: "0.021000",
    });
  });

  it("stores no project when none was suggested", async () => {
    const { model } = mockModel({ text: json(JIRA_JSON) });
    await generateDraft("conv-1", "jira", "user-1", {
      runtime: runtime(),
      model,
      projectId: null,
    });
    expect(state.drafts[0]).toMatchObject({ projectId: null });
  });

  it.each(PROVIDERS.map((p) => [p]))(
    "uses the turn loop's options, cache control and token limit (%s)",
    async (provider: Provider) => {
      const { calls } = await draft({ text: json(JIRA_JSON) }, "jira", {
        provider,
        effort: "high",
      });
      const call = calls[0] as CallOptions;
      const cache = cacheControlFor(provider);
      const expected = providerOptionsFor(provider, "high");
      for (const [name, options] of Object.entries(cache ?? {})) {
        expected[name] = { ...expected[name], ...options };
      }
      expect(call.providerOptions ?? {}).toEqual(expected);
      expect(call.maxOutputTokens).toBe(outputTokenLimitFor(provider));
      expect(call.prompt[0]?.providerOptions).toEqual(cache);
    }
  );

  it("asks for the BRD outline headings and stores the BRD", async () => {
    const brd = {
      title: "Iuran Tambahan",
      sections: [{ heading: "Business Process", body: "Alur saat ini." }],
    };
    const { calls } = await draft({ text: json(brd) }, "brd");
    const system = calls[0]?.prompt[0]?.content as string;
    for (const heading of BRD_SECTION_HEADINGS) {
      expect(system).toContain(heading);
    }
    expect(state.drafts[0]).toEqual({
      conversationId: "conv-1",
      projectId: "project-2",
      kind: "brd",
      content: brd,
    });
  });

  it("cuts an over-long draft to the stored limits", async () => {
    await draft({
      text: json({
        ...JIRA_JSON,
        summary: "x".repeat(400),
        acceptanceCriteria: Array.from({ length: 30 }, (_, i) => `AC ${i}`),
      }),
    });
    const content = state.drafts[0]?.content as {
      summary: string;
      acceptanceCriteria: string[];
    };
    expect(content.summary).toHaveLength(JIRA_SUMMARY_MAX);
    expect(content.acceptanceCriteria).toHaveLength(JIRA_CRITERIA_MAX);
    expect(jiraDraftSchema.safeParse(content).success).toBe(true);
  });

  it("charges an estimate when the provider reports no usage", async () => {
    await draft({ text: json(JIRA_JSON), usage: NO_USAGE });
    expect(state.usage).toHaveLength(1);
    const row = state.usage[0] ?? {};
    expect(row.estimated).toBe(true);
    // The prompt is at least the system prompt and the transcript.
    expect(row.inputTokens).toBeGreaterThan(500);
    expect(row.outputTokens).toBeGreaterThan(0);
    expect(Number(row.costUsd)).toBeGreaterThan(0);
  });
});

describe("generateDraft failures", () => {
  it("a refusal is assistant.refused, still metered, nothing stored", async () => {
    const error = await draftError({
      text: ['{"summ'],
      finish: "content-filter",
    });
    expect(error).toMatchObject({ code: "assistant.refused" });
    expect(state.usage).toHaveLength(1);
    expect(state.drafts).toEqual([]);
  });

  it("a truncated answer is assistant.failed before any parse", async () => {
    const error = await draftError({
      text: ['{"summary": "Perhit'],
      finish: "length",
    });
    expect(error).toBeInstanceOf(TurnError);
    expect(error).toMatchObject({ code: "assistant.failed" });
    expect(state.usage).toHaveLength(1);
    expect(state.drafts).toEqual([]);
  });

  it("output that does not match the schema is assistant.failed", async () => {
    const error = await draftError({
      text: json({ ...JIRA_JSON, issueType: "Epic" }),
    });
    expect(error).toMatchObject({ code: "assistant.failed" });
    expect(state.drafts).toEqual([]);
  });

  it("prose instead of JSON (the format was ignored) is assistant.model_no_drafts", async () => {
    const error = await draftError({
      text: ["Berikut draf tiketnya: ringkasan …"],
    });
    expect(error).toMatchObject({ code: "assistant.model_no_drafts" });
    expect(state.usage).toHaveLength(1);
    expect(state.drafts).toEqual([]);
  });

  it("a stream that fails midway is metered with an estimate and rethrown", async () => {
    const streamError = new APICallError({
      message: "overloaded",
      url: "https://llm.example.invalid/v1",
      requestBodyValues: {},
      statusCode: 529,
    });
    const error = await draftError({
      text: ['{"summary":'],
      streamError,
    });
    expect(classifyError(error)).toBe("assistant.unavailable");
    expect(state.usage).toHaveLength(1);
    expect(state.usage[0]?.estimated).toBe(true);
    expect(state.drafts).toEqual([]);
  });

  it("a conversation without a finished answer is assistant.nothing_to_draft, with no request", async () => {
    state.transcript = {
      messages: [{ role: "user", content: "Halo", context: { kind: "auto" } }],
    };
    const { model, calls } = mockModel({ text: [] });
    await expect(
      generateDraft("conv-1", "brd", "user-1", {
        runtime: runtime(),
        model,
        projectId: null,
      })
    ).rejects.toMatchObject({ code: "assistant.nothing_to_draft" });
    expect(calls).toEqual([]);
    expect(state.usage).toEqual([]);
  });
});

describe("structured output not supported", () => {
  const badRequest = (body: string) =>
    new APICallError({
      message: "Bad Request",
      url: "https://llm.example.invalid/v1",
      requestBodyValues: {},
      statusCode: 400,
      responseBody: body,
    });

  it.each([
    [
      "a response_format the endpoint rejects",
      badRequest(
        '{"error":{"message":"response_format type json_schema is not supported by this model"}}'
      ),
    ],
    [
      "a model without structured outputs",
      badRequest(
        '{"error":{"message":"This model does not support structured outputs"}}'
      ),
    ],
    [
      "an unsupported JSON mode",
      badRequest('{"error":{"message":"JSON mode is not supported"}}'),
    ],
    [
      "the SDK refusing the response format",
      new UnsupportedFunctionalityError({
        functionality: "responseFormat with a JSON schema",
      }),
    ],
  ])("%s is assistant.model_no_drafts", async (_name, error) => {
    expect(classifyError(error, { phase: "draft" })).toBe(
      "assistant.model_no_drafts"
    );
    const thrown = await draftError({ error });
    expect(classifyError(thrown, { phase: "draft" })).toBe(
      "assistant.model_no_drafts"
    );
    // A turn sends no response format: the same error there is no draft
    // problem.
    expect(classifyError(error)).toBe("assistant.failed");
    expect(classifyError(error, { phase: "turn" })).toBe("assistant.failed");
  });

  it("a tool-schema 400 stays assistant.failed", () => {
    expect(
      classifyError(
        badRequest(
          '{"error":{"message":"tools[0].input_schema: unsupported keyword"}}'
        )
      )
    ).toBe("assistant.failed");
  });
});

describe("draft prompts", () => {
  it("ask for one JSON object with exactly the schema's keys", () => {
    const jira = buildDraftSystemPrompt("jira", null);
    const brd = buildDraftSystemPrompt("brd", null);
    for (const prompt of [jira, brd]) {
      expect(prompt).toContain("Answer with one JSON object");
    }
    for (const key of Object.keys(jiraDraftSchema.shape)) {
      expect(jira).toContain(`"${key}"`);
    }
    for (const key of Object.keys(brdDraftSchema.shape)) {
      expect(brd).toContain(`"${key}"`);
    }
    const section = brdDraftSchema.shape.sections.element.shape;
    for (const key of Object.keys(section)) {
      expect(brd).toContain(`"${key}"`);
    }
    expect(jira).toContain('"acceptanceCriteria": ["');
    expect(brd).toContain('"sections": [{');
  });

  it("are English instructions that ask for Indonesian content", () => {
    for (const kind of ["brd", "jira"] as const) {
      const prompt = buildDraftSystemPrompt(kind, null);
      expect(prompt).toContain("Write the content in Indonesian");
      expect(prompt).toContain("Do not invent");
    }
  });

  it("describe the organisation generically when none is configured", () => {
    for (const kind of ["brd", "jira"] as const) {
      const prompt = buildDraftSystemPrompt(kind, null);
      expect(prompt).toContain(
        "a company that builds and runs pension-fund (DPLK/DPPK) systems"
      );
      expect(prompt).not.toContain("Organisation context:");
    }
  });

  it("include the configured organisation context, byte-stable", () => {
    for (const kind of ["brd", "jira"] as const) {
      const prompt = buildDraftSystemPrompt(kind, "Example Org runs funds.");
      expect(prompt).toContain(
        "Organisation context:\nExample Org runs funds."
      );
      expect(prompt).not.toContain("pension-fund (DPLK/DPPK) systems");
      expect(buildDraftSystemPrompt(kind, "Example Org runs funds.")).toBe(
        prompt
      );
    }
  });

  it("are sent with the runtime's organisation context", async () => {
    const { calls } = await draft({ text: json(JIRA_JSON) }, "jira", {
      orgContext: "Example Org runs funds.",
    });
    expect(calls[0]?.prompt[0]?.content).toContain("Example Org runs funds.");
  });
});
