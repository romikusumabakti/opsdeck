import type { AssistantPart } from "@/lib/assistant/turn-parts";

export type ToolPart = Extract<AssistantPart, { type: "dynamic-tool" }>;

/** One model step that called tools: its text (muted) and its calls. */
export type AnswerStep = { text: string; tools: ToolPart[] };

export type AnswerLayout = {
  steps: AnswerStep[];
  /** The last step's text when that step called no tool, else "". */
  answer: string;
  /** The steps fold away once a finished message has an answer. */
  collapsed: boolean;
};

/**
 * How an answer's parts are shown: split into steps at each `step-start`;
 * a step that called a tool is a tool step, its text shown muted above its
 * calls. The last step, while it has called no tool, is the answer, shown
 * normally even as it streams; a tool call arriving in it turns it into a
 * tool step, keeping its text. Text is never dropped: a tool-less step that
 * is not the last one is listed with the steps.
 */
export function layoutAnswer(
  parts: AssistantPart[],
  finished: boolean
): AnswerLayout {
  const groups: AnswerStep[] = [];
  for (const part of parts) {
    if (part.type === "step-start" || groups.length === 0) {
      groups.push({ text: "", tools: [] });
    }
    const step = groups[groups.length - 1] as AnswerStep;
    if (part.type === "text") step.text += part.text;
    else if (part.type === "dynamic-tool") step.tools.push(part);
  }
  const last = groups.at(-1);
  const answered = last !== undefined && last.tools.length === 0;
  const answer = answered ? last.text : "";
  const steps = (answered ? groups.slice(0, -1) : groups).filter(
    (step) => step.tools.length > 0 || step.text.trim() !== ""
  );
  return { steps, answer, collapsed: finished && answer.trim() !== "" };
}

const SUBJECT_KEYS = ["environment", "project", "key", "query"] as const;

/** What a tool call was about, for its chip: the first input that names one. */
export function toolSubject(input: Record<string, unknown>): string | null {
  for (const key of SUBJECT_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}
