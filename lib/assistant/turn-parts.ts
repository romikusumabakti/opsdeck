import type {
  DynamicToolUIPart,
  StepStartUIPart,
  TextStreamPart,
  TextUIPart,
  ToolSet,
  UIMessageChunk,
} from "ai";
import type { ToolMeta } from "./tools/code";

/** Provider and tool metadata and citations: never recorded on a part. */
type MetadataKey =
  | "citations"
  | "providerMetadata"
  | "callProviderMetadata"
  | "resultProviderMetadata"
  | "toolMetadata";

/** `T` without the metadata keys, for each member of a union. */
type WithoutMetadata<T> = T extends unknown ? Omit<T, MetadataKey> : never;

/**
 * One assistant turn as AI SDK UIMessage parts, in order: a step-start per
 * model request, its text, and its tool calls. Tool parts hold only an input
 * summary and the tool's audited result metadata (what the source chips
 * show), never the tool's data or error text: parts are persisted and sent to
 * the browser.
 *
 * The SDK's own part types, without the provider and tool metadata the
 * recorder never copies: its recursive JSON type is also too deep for the
 * Hono client to infer the API response from.
 */
export type AssistantPart = WithoutMetadata<
  StepStartUIPart | TextUIPart | DynamicToolUIPart
>;

/** The output of a tool part: never the data the tool returned. */
export type ToolPartOutput = { ok: boolean; meta: ToolMeta };

/** The metadata of the finish chunk: how the answer row ended. */
export type AnswerMetadata = {
  status: "done" | "failed";
  errorCode: string | null;
};

export type ToolInputSummary = Record<string, string | number | boolean | null>;

const INPUT_STRING_MAX = 120;
const ERROR_TEXT_MAX = 200;

/** `text` cut to `max` code points, with "…" when it was cut. */
function cut(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/**
 * A tool call's input as shown on its part: top-level scalars, and string
 * arrays joined with ", ", each string cut to 120 characters. Objects and
 * other arrays are dropped, as is any input that is not an object.
 */
export function summarizeToolInput(
  _tool: string,
  input: unknown
): ToolInputSummary {
  const summary: ToolInputSummary = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return summary;
  }
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      summary[key] = cut(value, INPUT_STRING_MAX);
    } else if (
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      summary[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      summary[key] = cut(value.join(", "), INPUT_STRING_MAX);
    }
  }
  return summary;
}

/** `{ ok, meta }` of a tool's ToolResult; its data and error are dropped. */
function toolOutputOf(output: unknown): ToolPartOutput {
  const result = (output ?? {}) as { ok?: unknown; meta?: unknown };
  const meta =
    typeof result.meta === "object" && result.meta !== null
      ? (result.meta as ToolMeta)
      : {};
  return { ok: result.ok !== false, meta };
}

function errorTextOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return cut(text, ERROR_TEXT_MAX);
}

/**
 * Turns streamText's fullStream into the turn's parts and the UI message
 * chunks a client renders them from (the same parts, chunk by chunk).
 */
export class TurnRecorder {
  private readonly list: AssistantPart[] = [];
  /** Text parts still streaming, by their stream id. */
  private readonly openText = new Map<string, TextUIPart>();
  /** Index in `list` of each tool part, by tool call id. */
  private readonly toolIndex = new Map<string, number>();
  /** The text of each step so far, in order. */
  private readonly stepTexts: string[] = [];

  constructor(private readonly messageId: string) {}

  get parts(): AssistantPart[] {
    return this.list;
  }

  start(): UIMessageChunk[] {
    return [{ type: "start", messageId: this.messageId }];
  }

  push(part: TextStreamPart<ToolSet>): UIMessageChunk[] {
    switch (part.type) {
      case "start-step":
        this.list.push({ type: "step-start" });
        this.stepTexts.push("");
        return [{ type: "start-step" }];
      case "text-start":
        this.openTextPart(part.id);
        return [{ type: "text-start", id: part.id }];
      case "text-delta": {
        const chunks: UIMessageChunk[] = [];
        let text = this.openText.get(part.id);
        if (!text) {
          text = this.openTextPart(part.id);
          chunks.push({ type: "text-start", id: part.id });
        }
        text.text += part.text;
        if (this.stepTexts.length === 0) this.stepTexts.push("");
        this.stepTexts[this.stepTexts.length - 1] += part.text;
        chunks.push({ type: "text-delta", id: part.id, delta: part.text });
        return chunks;
      }
      case "text-end": {
        const text = this.openText.get(part.id);
        if (!text) return [];
        text.state = "done";
        this.openText.delete(part.id);
        return [{ type: "text-end", id: part.id }];
      }
      case "tool-call": {
        const input = summarizeToolInput(part.toolName, part.input);
        this.toolIndex.set(part.toolCallId, this.list.length);
        this.list.push({
          type: "dynamic-tool",
          toolName: part.toolName,
          toolCallId: part.toolCallId,
          state: "input-available",
          input,
        });
        return [
          {
            type: "tool-input-available",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input,
            dynamic: true,
          },
        ];
      }
      case "tool-result": {
        const output = toolOutputOf(part.output);
        if (!this.settleTool(part.toolCallId, { output })) return [];
        return [
          {
            type: "tool-output-available",
            toolCallId: part.toolCallId,
            output,
            dynamic: true,
          },
        ];
      }
      case "tool-error": {
        const errorText = errorTextOf(part.error);
        if (!this.settleTool(part.toolCallId, { errorText })) return [];
        return [
          {
            type: "tool-output-error",
            toolCallId: part.toolCallId,
            errorText,
            dynamic: true,
          },
        ];
      }
      case "finish-step":
        return [{ type: "finish-step" }];
      default:
        // Reasoning, tool input streaming, sources, the stream's own start
        // and finish: not part of the answer.
        return [];
    }
  }

  finish(metadata: AnswerMetadata): UIMessageChunk[] {
    // A failure is told by its code only: an error chunk's text is prose.
    return [{ type: "finish", messageMetadata: metadata }];
  }

  /**
   * The answer: the last step's text; when that is empty (stopped mid-tool
   * step, or out of steps), the last non-empty step text; else "".
   */
  answerText(): string {
    return this.stepTexts.findLast((text) => text.trim() !== "") ?? "";
  }

  stepEnded(part: TextStreamPart<ToolSet>): boolean {
    return part.type === "finish-step";
  }

  private openTextPart(id: string): TextUIPart {
    const text: TextUIPart = { type: "text", text: "", state: "streaming" };
    this.list.push(text);
    this.openText.set(id, text);
    return text;
  }

  /** Ends a tool part with its output or error; false for an unknown call. */
  private settleTool(
    toolCallId: string,
    end: { output: ToolPartOutput } | { errorText: string }
  ): boolean {
    const index = this.toolIndex.get(toolCallId);
    const current = index === undefined ? undefined : this.list[index];
    if (index === undefined || current?.type !== "dynamic-tool") return false;
    const { toolName, input } = current;
    this.list[index] =
      "output" in end
        ? {
            type: "dynamic-tool",
            toolName,
            toolCallId,
            state: "output-available",
            input,
            output: end.output,
          }
        : {
            type: "dynamic-tool",
            toolName,
            toolCallId,
            state: "output-error",
            input,
            errorText: end.errorText,
          };
    return true;
  }
}
