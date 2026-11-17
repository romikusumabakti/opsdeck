import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaJSONOutputFormat,
  BetaMessage,
  BetaMessageParam,
  BetaOutputConfig,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { type AttachmentRef, parseAttachmentRefs } from "./attachment-refs";
import {
  ASSISTANT_EFFORTS,
  type AssistantEffort,
  type AssistantRuntime,
  loadAssistantRuntime,
} from "./client";
import {
  ensureSnapshot as defaultEnsureSnapshot,
  type Snapshot,
  SnapshotUnavailableError,
} from "./snapshot";
import {
  type AssistantSource,
  resolveEnvironmentSources as defaultResolveSources,
} from "./sources";
import {
  buildSystemPrompt,
  buildVolatileSystemNote,
  type PromptSource,
} from "./system-prompt";
import {
  executeTool as defaultExecuteTool,
  TOOL_DEFS,
  type ToolContext,
} from "./tool-defs";
import type { SnapshotRef, ToolResult } from "./tools/code";
import type { AttachmentContent } from "./tools/context";
import {
  claimMessage,
  finishMessage,
  loadTurn,
  recordToolCall,
  saveContent,
  saveSources,
  type TurnContext,
} from "./turn-store";
import { type ResponseUsage, recordUsage, spentTodayUsd } from "./usage";
import { type AssistantViewer, loadAssistantViewer } from "./viewer";

export const MAX_TOKENS = 32_000;
/**
 * Messages API requests per turn. The last one is sent with tool_choice none
 * and STEP_LIMIT_NOTE, so it answers with what the tools found so far.
 */
export const MAX_ITERATIONS = 25;
/** Appended to the tool results that precede the last allowed request. */
export const STEP_LIMIT_NOTE =
  "Batas langkah tercapai — jawab sekarang dengan temuan yang ada";
/**
 * Appended before the one final tool_choice none request sent when the daily
 * cap is reached mid-turn, so the user still gets an answer for what was spent.
 */
export const DAILY_CAP_NOTE =
  "Batas harian tercapai — jawab sekarang dengan temuan yang ada";
/** Streamed text is written to Postgres at most this often. */
export const FLUSH_INTERVAL_MS = 400;
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export type AssistantErrorCode =
  | "assistant.not_configured"
  | "assistant.daily_cap_reached"
  | "assistant.credit_exhausted"
  | "assistant.unavailable"
  | "assistant.refused"
  | "assistant.too_many_steps"
  | "assistant.interrupted"
  | "assistant.nothing_to_draft"
  | "assistant.failed";

export type RunTurnDeps = {
  client?: Anthropic;
  now?: () => Date;
  loadRuntime?: () => Promise<AssistantRuntime | null>;
  resolveSources?: (environmentId: string) => Promise<AssistantSource[]>;
  ensureSnapshot?: (source: AssistantSource) => Promise<Snapshot>;
  loadViewer?: (userId: string) => Promise<AssistantViewer>;
  /** The user's spend on the current quota day (USD). */
  spentToday?: (userId: string, now: Date) => Promise<number>;
  executeTool?: (
    name: string,
    input: unknown,
    ctx: ToolContext
  ) => Promise<ToolResult<unknown>>;
};

/** A turn- or request-level failure carrying its stable code. */
export class TurnError extends Error {
  constructor(readonly code: AssistantErrorCode) {
    super(code);
    this.name = "TurnError";
  }
}

/** Maps an error thrown by the SDK (or the loop) to the message's error code. */
export function classifyError(error: unknown): AssistantErrorCode {
  if (error instanceof TurnError) return error.code;
  // Connection failures and timeouts are APIError subclasses without a status.
  if (error instanceof Anthropic.APIConnectionError) {
    return "assistant.unavailable";
  }
  if (error instanceof Anthropic.APIError) {
    const message = `${error.apiMessage ?? ""} ${error.message}`;
    if (
      error.type === "billing_error" ||
      error.status === 402 ||
      ((error.status === 400 || error.type === "invalid_request_error") &&
        /credit balance/i.test(message))
    ) {
      return "assistant.credit_exhausted";
    }
    if (
      error.status === 401 ||
      error.status === 403 ||
      error.type === "authentication_error" ||
      error.type === "permission_error"
    ) {
      return "assistant.not_configured";
    }
    // Mid-stream SSE errors carry a type but no HTTP status.
    if (
      error.status === 429 ||
      (error.status !== undefined && error.status >= 500) ||
      error.type === "rate_limit_error" ||
      error.type === "overloaded_error" ||
      error.type === "api_error" ||
      error.type === "timeout_error"
    ) {
      return "assistant.unavailable";
    }
  }
  return "assistant.failed";
}

/** Tool definitions with the prompt-cache breakpoint on the last one. */
function cachedTools(): BetaToolUnion[] {
  return TOOL_DEFS.map((tool, index) =>
    index === TOOL_DEFS.length - 1
      ? { ...tool, cache_control: { type: "ephemeral" } }
      : tool
  );
}

/**
 * Prior messages as plain text turns. Failed assistant messages without any
 * text and unfinished ones are skipped; consecutive same-role turns are fine
 * (the API merges them).
 */
export function buildHistory(turn: TurnContext): BetaMessageParam[] {
  const messages: BetaMessageParam[] = [];
  const lastUserIndex = turn.history.findLastIndex((m) => m.role === "user");
  const ticked = parseAttachmentRefs(turn.attachmentIds);
  turn.history.forEach((m, index) => {
    if (m.role === "assistant") {
      if (m.status !== "done" && m.status !== "failed") return;
      if (m.content.trim() === "") return;
      messages.push({ role: "assistant", content: m.content });
      return;
    }
    let text = m.content;
    if (index === lastUserIndex && ticked.length > 0) {
      const list = ticked
        .map(
          (a) => `- issue_key ${a.issueKey}, attachment_id ${a.attachmentId}`
        )
        .join("\n");
      text += `\n\n(Attachments ticked for this question, readable with read_attachment:\n${list})`;
    }
    messages.push({ role: "user", content: text });
  });
  return messages;
}

/**
 * The assistant content to send back within the tool loop. Thinking blocks go
 * back unchanged. After a mid-output refusal fallback, the thinking and
 * tool_use blocks of the declined attempt (before the last fallback block) are
 * dropped, the fallback block itself stays where it was.
 */
export function echoContent(
  content: BetaContentBlock[]
): BetaContentBlockParam[] {
  const boundary = content.findLastIndex((b) => b.type === "fallback");
  if (boundary === -1) return content as BetaContentBlockParam[];
  return content.filter(
    (b, index) => index >= boundary || b.type === "text"
  ) as BetaContentBlockParam[];
}

/** A read_attachment result as content blocks Claude reads natively. */
function attachmentBlocks(
  data: AttachmentContent
): Exclude<BetaToolResultBlockParam["content"], string | undefined> {
  switch (data.kind) {
    case "document":
      return [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: data.mediaType,
            data: data.base64,
          },
        },
      ];
    case "image":
      return [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: data.mediaType,
            data: data.base64,
          },
        },
      ];
    case "text":
      return [{ type: "text", text: data.text }];
  }
}

/**
 * One tool's result as a tool_result block: read_attachment data
 * (AttachmentContent) becomes document/image/text blocks, any other tool's
 * data JSON text, a failure an is_error result.
 */
export function toToolResult(
  toolName: string,
  toolUseId: string,
  result: ToolResult<unknown>
): BetaToolResultBlockParam {
  if (!result.ok) {
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      is_error: true,
      content: result.error,
    };
  }
  if (toolName === "read_attachment") {
    return {
      type: "tool_result",
      tool_use_id: toolUseId,
      content: attachmentBlocks(result.data as AttachmentContent),
    };
  }
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify(result.data),
  };
}

type ResolvedSources = { prompt: PromptSource[]; snaps: SnapshotRef[] };

async function resolveSnapshots(
  environmentId: string | null,
  deps: Required<Pick<RunTurnDeps, "resolveSources" | "ensureSnapshot">>
): Promise<ResolvedSources> {
  if (!environmentId) return { prompt: [], snaps: [] };
  const sources = await deps.resolveSources(environmentId);
  // Downloads run in parallel; the order of the sources is kept.
  type Outcome =
    | { source: AssistantSource; snap: Snapshot }
    | { source: AssistantSource; reason: string };
  const outcomes = await Promise.all(
    sources.map(async (source): Promise<Outcome> => {
      try {
        return { source, snap: await deps.ensureSnapshot(source) };
      } catch (error) {
        if (error instanceof SnapshotUnavailableError) {
          return { source, reason: error.reason };
        }
        console.error(
          `[assistant] snapshot of ${source.repoFullName}@${source.ref} failed`,
          error
        );
        return { source, reason: "download-failed" };
      }
    })
  );
  const prompt: PromptSource[] = [];
  const snaps: SnapshotRef[] = [];
  for (const outcome of outcomes) {
    const { source } = outcome;
    if ("snap" in outcome) {
      prompt.push({ ...source, commitSha: outcome.snap.commitSha });
      snaps.push({
        componentKey: source.componentKey,
        dir: outcome.snap.dir,
        commitSha: outcome.snap.commitSha,
      });
    } else {
      prompt.push({ ...source, unavailableReason: outcome.reason });
    }
  }
  return { prompt, snaps };
}

/**
 * The answer text, flushed to Postgres at most every 400 ms. Only the final
 * response's text is the answer: text of a response that ends in tool calls
 * streams live while it is written, then is dropped (R11).
 */
class ContentWriter {
  private current = "";
  private lastFlush = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly messageId: string,
    private readonly now: () => Date
  ) {}

  get text(): string {
    return this.current;
  }

  private save(snapshot: string): void {
    // Writes are chained so an older snapshot never lands after a newer one.
    this.pending = this.pending.then(() =>
      saveContent(this.messageId, snapshot).catch((error) => {
        console.error("[assistant] failed to save streamed content", error);
      })
    );
  }

  append(delta: string): void {
    this.current += delta;
    const at = this.now().getTime();
    if (at - this.lastFlush >= FLUSH_INTERVAL_MS) {
      this.lastFlush = at;
      this.save(this.current);
    }
  }

  /** The response ended in tool calls: its text is not the answer. */
  discard(): void {
    if (this.current === "") return;
    this.current = "";
    this.save("");
  }

  async settle(): Promise<void> {
    await this.pending;
  }
}

/**
 * Runs one assistant turn: the message row (status queued) was created with
 * the user's question. Streams Claude's answer into the row, runs the tools
 * it asks for, meters every response, and ends the row done or failed with a
 * stable error code. Never throws for a turn-level failure.
 */
export async function runTurn(
  messageId: string,
  deps: RunTurnDeps = {}
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const turn = await loadTurn(messageId);
  if (!turn) {
    console.warn(`[assistant] message ${messageId} not found; job dropped`);
    return;
  }
  if (turn.status === "streaming") {
    // A job redelivered after its worker died mid-turn: the first run's
    // partial state cannot be resumed.
    await finishMessage(
      messageId,
      {
        status: "failed",
        content: turn.content,
        errorCode: "assistant.interrupted",
      },
      now()
    ).catch((error) => {
      console.error(
        `[assistant] failed to mark redelivered turn ${messageId} interrupted`,
        error
      );
    });
    return;
  }
  if (turn.status !== "queued" || !(await claimMessage(messageId))) return;

  const writer = new ContentWriter(messageId, now);
  try {
    await runClaimedTurn(turn, writer, deps, now);
    await writer.settle();
    await finishMessage(
      messageId,
      { status: "done", content: writer.text },
      now()
    );
  } catch (error) {
    const code = classifyError(error);
    if (code === "assistant.failed") {
      console.error(`[assistant] turn ${messageId} failed`, error);
    }
    await writer.settle();
    await finishMessage(
      messageId,
      { status: "failed", content: writer.text, errorCode: code },
      now()
    );
  }
}

async function loadRuntimeOrFail(deps: RunTurnDeps): Promise<AssistantRuntime> {
  let runtime: AssistantRuntime | null;
  try {
    runtime = await (deps.loadRuntime ?? loadAssistantRuntime)();
  } catch (error) {
    // Typically a stored key that no longer decrypts (rotated SECRETS_KEY).
    console.error("[assistant] could not load the assistant settings", error);
    throw new TurnError("assistant.not_configured");
  }
  if (!runtime) throw new TurnError("assistant.not_configured");
  return deps.client ? { ...runtime, client: deps.client } : runtime;
}

async function runClaimedTurn(
  turn: TurnContext,
  writer: ContentWriter,
  deps: RunTurnDeps,
  now: () => Date
): Promise<void> {
  const runtime = await loadRuntimeOrFail(deps);
  const spentToday = deps.spentToday ?? spentTodayUsd;
  // The cap is checked at send time too, but turns already queued (or a long
  // tool loop) can still cross it: re-checked before every request. Before the
  // first request it fails the turn (nothing spent yet); later it allows one
  // final answer-only request (see the loop).
  const capReached = async () =>
    (await spentToday(turn.userId, now())) >= runtime.dailyCapUsd;
  if (await capReached()) throw new TurnError("assistant.daily_cap_reached");
  const viewer = await (deps.loadViewer ?? loadAssistantViewer)(turn.userId);
  const resolved = await resolveSnapshots(turn.environmentId, {
    resolveSources: deps.resolveSources ?? defaultResolveSources,
    ensureSnapshot:
      deps.ensureSnapshot ?? ((source) => defaultEnsureSnapshot(source)),
  });
  // Stored without the turn-only unavailableReason; unavailable components
  // keep a null commit.
  await saveSources(
    turn.messageId,
    resolved.prompt.map(({ unavailableReason, ...source }) =>
      unavailableReason ? { ...source, commitSha: null } : source
    )
  );

  const system = [
    {
      type: "text" as const,
      text: buildSystemPrompt({
        projectName: turn.projectName,
        environmentName: turn.environmentName,
        sources: resolved.prompt,
        userName: turn.userName,
      }),
      cache_control: { type: "ephemeral" as const },
    },
    { type: "text" as const, text: buildVolatileSystemNote(now()) },
  ];
  const tools = cachedTools();
  const messages = buildHistory(turn);
  const attachments: AttachmentRef[] = parseAttachmentRefs(turn.attachmentIds);
  const toolContext: ToolContext = {
    snaps: resolved.snaps,
    viewer,
    attachments,
  };
  const execute = deps.executeTool ?? defaultExecuteTool;
  const meter = (model: string, usage: ResponseUsage) =>
    recordUsage({
      messageId: turn.messageId,
      userId: turn.userId,
      model,
      usage,
      priceModel: runtime.model,
      now: now(),
    });

  let capped = false;
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    let last = iteration === MAX_ITERATIONS;
    if (iteration > 1 && (await capReached())) {
      // Never more than one extra request past the cap.
      if (capped) throw new TurnError("assistant.daily_cap_reached");
      capped = true;
      last = true;
      appendNote(messages, DAILY_CAP_NOTE);
    }
    const message = await streamRequest(
      runtime,
      // The same tools on the last request keep the cached prefix; "none"
      // makes it answer instead of asking for more.
      { system, tools, toolChoice: last ? "none" : "auto", messages },
      (delta) => writer.append(delta),
      meter
    );
    await meter(message.model, message.usage);
    if (message.stop_reason === "tool_use") writer.discard();

    switch (message.stop_reason) {
      case "end_turn":
      case "stop_sequence":
        return;
      case "refusal":
        throw new TurnError("assistant.refused");
      case "pause_turn":
        messages.push({
          role: "assistant",
          content: echoContent(message.content),
        });
        continue;
      case "tool_use":
        break;
      default:
        // max_tokens (a truncated answer or tool input), context overflow.
        console.error(
          `[assistant] turn ${turn.messageId} stopped: ${message.stop_reason}`
        );
        throw new TurnError("assistant.failed");
    }

    const toolUses = message.content
      .slice(
        Math.max(
          0,
          message.content.findLastIndex((b) => b.type === "fallback")
        )
      )
      .filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) return;
    // Still asked for tools despite tool_choice none.
    if (last) {
      if (capped) throw new TurnError("assistant.daily_cap_reached");
      break;
    }

    messages.push({ role: "assistant", content: echoContent(message.content) });
    const results = await Promise.all(
      toolUses.map(async (use) => {
        const result = await execute(use.name, use.input, toolContext);
        await recordToolCall(
          turn.messageId,
          use.name,
          (use.input ?? {}) as Record<string, unknown>,
          result.meta as Record<string, unknown>
        );
        return toToolResult(use.name, use.id, result);
      })
    );
    // All results of one response go back in a single user message; before
    // the last allowed request, with the note that it must answer now.
    messages.push({
      role: "user",
      content:
        iteration + 1 === MAX_ITERATIONS
          ? [...results, { type: "text", text: STEP_LIMIT_NOTE }]
          : results,
    });
  }
  throw new TurnError("assistant.too_many_steps");
}

/** Adds a text note to the trailing user message (or a new one). */
function appendNote(messages: BetaMessageParam[], note: string): void {
  const tail = messages.at(-1);
  if (tail?.role === "user" && Array.isArray(tail.content)) {
    tail.content = [...tail.content, { type: "text", text: note }];
  } else {
    messages.push({ role: "user", content: [{ type: "text", text: note }] });
  }
}

export function effortOf(
  runtime: AssistantRuntime
): BetaOutputConfig["effort"] {
  if ((ASSISTANT_EFFORTS as readonly string[]).includes(runtime.effort)) {
    return runtime.effort as AssistantEffort;
  }
  console.warn(
    `[assistant] unknown effort ${runtime.effort}; using the model default`
  );
  return undefined;
}

export type RequestBody = {
  system: Array<{
    type: "text";
    text: string;
    cache_control?: { type: "ephemeral" };
  }>;
  /** The tool loop's tools; a request without them is a one-shot answer. */
  tools?: BetaToolUnion[];
  /** With tools: "auto" (default), or "none" to force a text answer. */
  toolChoice?: "auto" | "none";
  /** Structured output (`output_config.format`), parsed by the caller. */
  format?: BetaJSONOutputFormat;
  messages: BetaMessageParam[];
};

/**
 * One streamed Messages request with the assistant's fixed settings (model,
 * effort, refusal fallback, adaptive thinking, max_tokens). Text deltas go to
 * `onText`. If the stream fails, the usage it reported so far is metered
 * before the error is rethrown (those tokens are billed).
 */
export async function streamRequest(
  runtime: AssistantRuntime,
  body: RequestBody,
  onText: (delta: string) => void,
  meter: (model: string, usage: ResponseUsage) => Promise<number>
): Promise<BetaMessage> {
  const effort = effortOf(runtime);
  const outputConfig = {
    ...(effort ? { effort } : {}),
    ...(body.format ? { format: body.format } : {}),
  };
  const stream = runtime.client.beta.messages.stream({
    model: runtime.model,
    max_tokens: MAX_TOKENS,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    ...(Object.keys(outputConfig).length > 0
      ? { output_config: outputConfig }
      : {}),
    system: body.system,
    ...(body.tools
      ? {
          tools: body.tools,
          tool_choice: { type: body.toolChoice ?? "auto" },
          // Caches the growing conversation, so each tool-loop request
          // re-reads the previous one's prefix instead of paying for it again.
          cache_control: { type: "ephemeral" as const },
        }
      : {}),
    // A copy: the loop appends to `messages` after this request.
    messages: [...body.messages],
  });
  try {
    // After a mid-output refusal fallback the fallback model continues the
    // partial text, so streamed text is never discarded.
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        onText(event.delta.text);
      }
    }
    return await stream.finalMessage();
  } catch (error) {
    // The tokens streamed before the error are billed; meter what the
    // stream reported so far (message_start and any message_delta).
    const partial = stream.currentMessage;
    if (partial?.usage) {
      await meter(partial.model, partial.usage).catch((meterError) => {
        console.error("[assistant] failed to record partial usage", meterError);
      });
    }
    throw error;
  }
}
