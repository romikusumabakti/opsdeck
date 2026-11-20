import type { TextStreamPart, ToolSet, UIMessage, UIMessageChunk } from "ai";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AssistantPart,
  summarizeToolInput,
  TurnRecorder,
} from "@/lib/assistant/turn-parts";

type Part = TextStreamPart<ToolSet>;

const SECRET_TITLE = "secret-issue-title-marker";

/** Only the fields TurnRecorder reads; the rest of a step part is noise. */
const startStep = { type: "start-step" } as Part;
const finishStep = (finishReason: "stop" | "tool-calls"): Part =>
  ({ type: "finish-step", finishReason }) as Part;

function textParts(id: string, ...deltas: string[]): Part[] {
  return [
    { type: "text-start", id },
    ...deltas.map((text): Part => ({ type: "text-delta", id, text })),
    { type: "text-end", id },
  ];
}

const listIssuesCall = {
  type: "tool-call",
  toolCallId: "tu_1",
  toolName: "list_issues",
  input: { query: null },
} as Part;

const listIssuesResult = {
  type: "tool-result",
  toolCallId: "tu_1",
  toolName: "list_issues",
  input: { query: null },
  output: {
    ok: true,
    data: { total: 3, issues: [{ key: "A-1", title: SECRET_TITLE }] },
    meta: { issueKeys: ["A-1"] },
  },
} as Part;

function record(parts: Part[]): {
  recorder: TurnRecorder;
  chunks: UIMessageChunk[];
} {
  const recorder = new TurnRecorder("msg-1");
  const chunks = [...recorder.start()];
  for (const part of parts) chunks.push(...recorder.push(part));
  return { recorder, chunks };
}

const twoStepTurn: Part[] = [
  startStep,
  ...textParts("0", "Checking ", "issues."),
  listIssuesCall,
  listIssuesResult,
  finishStep("tool-calls"),
  startStep,
  ...textParts("0", "There are 3 issues."),
  finishStep("stop"),
];

describe("TurnRecorder", () => {
  it("records parts a UIMessage holds", () => {
    expectTypeOf<AssistantPart>().toExtend<UIMessage["parts"][number]>();
  });

  it("records a two-step turn as ordered parts: text, tool, then the answer", () => {
    const { recorder, chunks } = record(twoStepTurn);
    expect(recorder.parts.map((p) => p.type)).toEqual([
      "step-start",
      "text",
      "dynamic-tool",
      "step-start",
      "text",
    ]);
    expect(recorder.parts[1]).toEqual({
      type: "text",
      text: "Checking issues.",
      state: "done",
    });
    expect(recorder.parts[2]).toMatchObject({
      type: "dynamic-tool",
      toolName: "list_issues",
      toolCallId: "tu_1",
      state: "output-available",
      input: { query: null },
    });
    expect(recorder.answerText()).toBe("There are 3 issues.");
    expect(chunks[0]).toEqual({ type: "start", messageId: "msg-1" });
    expect(chunks.map((c) => c.type)).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-delta",
      "text-end",
      "tool-input-available",
      "tool-output-available",
      "finish-step",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
    ]);
    expect(chunks[6]).toEqual({
      type: "tool-input-available",
      toolCallId: "tu_1",
      toolName: "list_issues",
      input: { query: null },
      dynamic: true,
    });
  });

  it("never copies tool output into parts or chunks", () => {
    const { recorder, chunks } = record(twoStepTurn);
    expect(JSON.stringify(recorder.parts)).not.toContain(SECRET_TITLE);
    expect(JSON.stringify(chunks)).not.toContain(SECRET_TITLE);
    const tool = recorder.parts.find((p) => p.type === "dynamic-tool");
    expect(tool).toMatchObject({
      output: { ok: true, meta: { issueKeys: ["A-1"] } },
    });
    expect(tool && "output" in tool ? tool.output : null).toEqual({
      ok: true,
      meta: { issueKeys: ["A-1"] },
    });
  });

  it("records a tool error and an invalid call as output errors, cut short", () => {
    const { recorder, chunks } = record([
      startStep,
      {
        type: "tool-call",
        toolCallId: "tu_2",
        toolName: "read_file",
        input: "{not json",
        dynamic: true,
        invalid: true,
        error: new Error("bad"),
      } as Part,
      {
        type: "tool-error",
        toolCallId: "tu_2",
        toolName: "read_file",
        input: "{not json",
        error: "e".repeat(500),
        dynamic: true,
      } as Part,
      finishStep("tool-calls"),
    ]);
    const tool = recorder.parts[1];
    expect(tool).toMatchObject({
      type: "dynamic-tool",
      state: "output-error",
      input: {},
    });
    const errorText = tool && "errorText" in tool ? tool.errorText : "";
    expect(errorText).toHaveLength(201);
    expect(errorText?.endsWith("…")).toBe(true);
    expect(chunks.find((c) => c.type === "tool-output-error")).toEqual({
      type: "tool-output-error",
      toolCallId: "tu_2",
      errorText,
      dynamic: true,
    });
  });

  it("ignores reasoning and tool input streaming", () => {
    const { recorder, chunks } = record([
      startStep,
      { type: "reasoning-start", id: "r" } as Part,
      { type: "reasoning-delta", id: "r", text: "hmm" } as Part,
      { type: "reasoning-end", id: "r" } as Part,
      { type: "tool-input-start", id: "tu_1", toolName: "list_issues" } as Part,
      { type: "tool-input-delta", id: "tu_1", delta: "{}" } as Part,
    ]);
    expect(recorder.parts).toEqual([{ type: "step-start" }]);
    expect(chunks.map((c) => c.type)).toEqual(["start", "start-step"]);
  });

  it("answerText falls back to the last non-empty step text", () => {
    const { recorder } = record([
      startStep,
      ...textParts("0", "Looking."),
      listIssuesCall,
      listIssuesResult,
      finishStep("tool-calls"),
      startStep,
    ]);
    expect(recorder.answerText()).toBe("Looking.");
    expect(new TurnRecorder("m").answerText()).toBe("");
  });

  it("reports the end of a step", () => {
    const recorder = new TurnRecorder("m");
    expect(recorder.stepEnded(finishStep("stop"))).toBe(true);
    expect(recorder.stepEnded(startStep)).toBe(false);
  });

  it("finish carries status and errorCode, never an error chunk", () => {
    const recorder = new TurnRecorder("m");
    expect(
      recorder.finish({
        status: "failed",
        errorCode: "assistant.daily_cap_reached",
      })
    ).toEqual([
      {
        type: "finish",
        messageMetadata: {
          status: "failed",
          errorCode: "assistant.daily_cap_reached",
        },
      },
    ]);
  });
});

describe("summarizeToolInput", () => {
  it("summarises tool input", () => {
    const summary = summarizeToolInput("query_database", {
      sql: "x".repeat(500),
      limit: 5,
      nested: { a: 1 },
    });
    expect(summary.sql).toHaveLength(121);
    expect(String(summary.sql).endsWith("…")).toBe(true);
    expect(summary.limit).toBe(5);
    expect("nested" in summary).toBe(false);
  });

  it("keeps scalars and joins string arrays; drops other arrays", () => {
    expect(
      summarizeToolInput("list_issues", {
        query: null,
        status: ["open", "in_progress"],
        mine: true,
        ids: [1, 2],
        missing: undefined,
      })
    ).toEqual({ query: null, status: "open, in_progress", mine: true });
    expect(summarizeToolInput("x", "not an object")).toEqual({});
    expect(summarizeToolInput("x", ["a"])).toEqual({});
  });
});
