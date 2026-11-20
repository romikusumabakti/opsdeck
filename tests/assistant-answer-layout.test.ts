import { describe, expect, it } from "vitest";
import type { AssistantPart } from "@/lib/assistant/turn-parts";
import {
  layoutAnswer,
  toolSubject,
} from "@/web/components/assistant/answer-layout";

const tool = (
  toolCallId: string,
  state: "input-available" | "output-available" = "output-available"
): AssistantPart =>
  state === "output-available"
    ? {
        type: "dynamic-tool",
        toolName: "list_issues",
        toolCallId,
        state,
        input: { query: "today" },
        output: { ok: true, meta: {} },
      }
    : {
        type: "dynamic-tool",
        toolName: "list_issues",
        toolCallId,
        state,
        input: { query: "today" },
      };
const text = (value: string): AssistantPart => ({
  type: "text",
  text: value,
  state: "done",
});
const step: AssistantPart = { type: "step-start" };

describe("layoutAnswer", () => {
  it("splits a finished two-step turn into one tool step and the answer, collapsed", () => {
    const layout = layoutAnswer(
      [step, text("Checking issues."), tool("c1"), step, text("Three issues.")],
      true
    );
    expect(layout.steps).toHaveLength(1);
    expect(layout.steps[0]?.text).toBe("Checking issues.");
    expect(layout.steps[0]?.tools.map((t) => t.toolCallId)).toEqual(["c1"]);
    expect(layout.answer).toBe("Three issues.");
    expect(layout.collapsed).toBe(true);
  });

  it("live: the last step's text is the answer until a tool arrives, then it is a muted tool step", () => {
    const before = layoutAnswer([step, text("Checking issues.")], false);
    expect(before.steps).toEqual([]);
    expect(before.answer).toBe("Checking issues.");
    expect(before.collapsed).toBe(false);

    const after = layoutAnswer(
      [step, text("Checking issues."), tool("c1", "input-available")],
      false
    );
    expect(after.answer).toBe("");
    expect(after.steps).toHaveLength(1);
    expect(after.steps[0]?.text).toBe("Checking issues.");
    expect(after.steps[0]?.tools[0]?.state).toBe("input-available");
    expect(after.collapsed).toBe(false);

    // A new step starts: the tool step stays, the answer is empty so far.
    const next = layoutAnswer(
      [step, text("Checking issues."), tool("c1"), step],
      false
    );
    expect(next.steps[0]?.text).toBe("Checking issues.");
    expect(next.answer).toBe("");
  });

  it("no answer (stopped mid-tool): not collapsed", () => {
    const layout = layoutAnswer(
      [step, text("Checking issues."), tool("c1", "input-available")],
      true
    );
    expect(layout.answer).toBe("");
    expect(layout.steps).toHaveLength(1);
    expect(layout.collapsed).toBe(false);
  });

  it("a finished answer without tools has no steps; parts before a step-start form one", () => {
    expect(layoutAnswer([text("Hi.")], true)).toEqual({
      steps: [],
      answer: "Hi.",
      collapsed: true,
    });
    expect(layoutAnswer([], true)).toEqual({
      steps: [],
      answer: "",
      collapsed: false,
    });
  });
});

describe("toolSubject", () => {
  it("toolSubject prefers environment, then project, key, query", () => {
    expect(
      toolSubject({
        query: "q",
        key: "KST-1",
        project: "HMEM",
        environment: "HMEM/dev",
      })
    ).toBe("HMEM/dev");
    expect(toolSubject({ query: "q", key: "KST-1", project: "HMEM" })).toBe(
      "HMEM"
    );
    expect(toolSubject({ query: "q", key: "KST-1" })).toBe("KST-1");
    expect(toolSubject({ query: "q", limit: 5 })).toBe("q");
    expect(toolSubject({ limit: 5 })).toBeNull();
    expect(toolSubject({ environment: "", project: "HMEM" })).toBe("HMEM");
  });
});
