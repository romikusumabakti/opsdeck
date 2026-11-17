import {
  APICallError,
  type LanguageModel,
  LoadAPIKeyError,
  type ModelMessage,
  RetryError,
  type StepResult,
  StreamProviderError,
  type SystemModelMessage,
  stepCountIs,
  streamText,
  ToolChoiceViolationError,
  type ToolSet,
  UnsupportedFunctionalityError,
} from "ai";
import { type AttachmentRef, parseAttachmentRefs } from "./attachment-refs";
import { type AssistantRuntime, loadAssistantRuntime } from "./client";
import { estimateUsage, type TokenUsage } from "./pricing";
import {
  cacheControlFor,
  type ProviderOptions,
  providerOptionsFor,
} from "./providers";
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
import { buildTools, type ToolContext, type ToolExecutor } from "./tool-defs";
import type { SnapshotRef } from "./tools/code";
import {
  claimMessage,
  finishMessage,
  loadTurn,
  recordToolCall,
  saveContent,
  saveSources,
  type TurnContext,
} from "./turn-store";
import { recordUsage, spentTodayUsd } from "./usage";
import { type AssistantViewer, loadAssistantViewer } from "./viewer";

export const MAX_TOKENS = 32_000;
/**
 * Model requests (steps) per turn. The last one is sent with tool choice
 * none and STEP_LIMIT_NOTE, so it answers with what the tools found so far.
 */
export const MAX_ITERATIONS = 25;
/** Sent after the tool results that precede the last allowed request. */
export const STEP_LIMIT_NOTE =
  "Batas langkah tercapai — jawab sekarang dengan temuan yang ada";
/**
 * Sent before the one final tool-choice-none request made when the daily
 * cap is reached mid-turn, so the user still gets an answer for what was spent.
 */
export const DAILY_CAP_NOTE =
  "Batas harian tercapai — jawab sekarang dengan temuan yang ada";
/** Streamed text is written to Postgres at most this often. */
export const FLUSH_INTERVAL_MS = 400;

export type AssistantErrorCode =
  | "assistant.not_configured"
  | "assistant.daily_cap_reached"
  | "assistant.credit_exhausted"
  | "assistant.unavailable"
  | "assistant.refused"
  | "assistant.too_many_steps"
  | "assistant.interrupted"
  | "assistant.nothing_to_draft"
  | "assistant.model_no_tools"
  | "assistant.model_no_drafts"
  | "assistant.environment_gone"
  | "assistant.failed";

export type RunTurnDeps = {
  /** Replaces the runtime's model (tests inject a mock). */
  model?: LanguageModel;
  now?: () => Date;
  loadRuntime?: () => Promise<AssistantRuntime | null>;
  resolveSources?: (environmentId: string) => Promise<AssistantSource[]>;
  ensureSnapshot?: (source: AssistantSource) => Promise<Snapshot>;
  loadViewer?: (userId: string) => Promise<AssistantViewer>;
  /** The user's spend on the current quota day (USD). */
  spentToday?: (userId: string, now: Date) => Promise<number>;
  executeTool?: ToolExecutor;
};

/** A turn- or request-level failure carrying its stable code. */
export class TurnError extends Error {
  constructor(readonly code: AssistantErrorCode) {
    super(code);
    this.name = "TurnError";
  }
}

/** The status and text of a failed provider call, if it was one. */
function providerFailureOf(
  error: unknown
): { status: number | undefined; text: string; retryable: boolean } | null {
  if (APICallError.isInstance(error)) {
    // No status: the request never got a response (connection, DNS, reset).
    return {
      status: error.statusCode,
      text: `${error.message} ${error.responseBody ?? ""}`,
      retryable: error.statusCode === undefined || error.isRetryable,
    };
  }
  if (StreamProviderError.isInstance(error)) {
    // An error event after the response stream started.
    return {
      status: error.statusCode,
      text: `${error.message} ${error.type ?? ""} ${error.code ?? ""}`,
      retryable: error.isRetryable,
    };
  }
  return null;
}

const MENTIONS_BILLING = /credit|billing|quota/i;
const MENTIONS_API_KEY = /api[_ ]?key/i;
const MENTIONS_TOOLS = /\btools?\b|tool[ _-]?(use|call)|function[ _-]?call/i;
const MENTIONS_SUPPORT = /support/i;

/** Maps an error thrown by the SDK (or the loop) to the message's error code. */
export function classifyError(error: unknown): AssistantErrorCode {
  if (error instanceof TurnError) return error.code;
  if (RetryError.isInstance(error)) return classifyError(error.lastError);
  if (LoadAPIKeyError.isInstance(error)) return "assistant.not_configured";
  if (UnsupportedFunctionalityError.isInstance(error)) {
    return MENTIONS_TOOLS.test(error.functionality)
      ? "assistant.model_no_tools"
      : "assistant.failed";
  }
  const failure = providerFailureOf(error);
  if (!failure) return "assistant.failed";
  const { status, text } = failure;
  if (status === 401 || status === 403) return "assistant.not_configured";
  if (
    status === 402 ||
    ((status === 400 || status === 429) && MENTIONS_BILLING.test(text))
  ) {
    return "assistant.credit_exhausted";
  }
  if (status === 400 && MENTIONS_API_KEY.test(text)) {
    return "assistant.not_configured";
  }
  if (
    status === 400 &&
    MENTIONS_TOOLS.test(text) &&
    MENTIONS_SUPPORT.test(text)
  ) {
    return "assistant.model_no_tools";
  }
  if (status === undefined) {
    return failure.retryable ? "assistant.unavailable" : "assistant.failed";
  }
  if (status === 429 || status >= 500) return "assistant.unavailable";
  return "assistant.failed";
}

/**
 * Prior messages as plain text turns. Failed assistant messages without any
 * text and unfinished ones are skipped; consecutive same-role turns are fine
 * (the API merges them).
 */
export function buildHistory(turn: TurnContext): ModelMessage[] {
  const messages: ModelMessage[] = [];
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
 * the user's question. Streams the model's answer into the row, runs the tools
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
  return deps.model ? { ...runtime, model: deps.model } : runtime;
}

/** Shallow per-provider merge: `extra` adds keys to each provider's options. */
function mergeProviderOptions(
  base: ProviderOptions,
  extra: ProviderOptions | undefined
): ProviderOptions {
  const merged: ProviderOptions = { ...base };
  for (const [provider, options] of Object.entries(extra ?? {})) {
    merged[provider] = { ...merged[provider], ...options };
  }
  return merged;
}

/**
 * The tokens a step reports, split the way they are billed, or null when the
 * provider reported none.
 */
function reportedUsage(step: StepResult<ToolSet>): TokenUsage | null {
  const { usage } = step;
  if (usage.inputTokens == null && usage.outputTokens == null) return null;
  const details = usage.inputTokenDetails;
  const cacheRead = details?.cacheReadTokens ?? 0;
  const cacheWrite = details?.cacheWriteTokens ?? 0;
  const input =
    details?.noCacheTokens ??
    Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);
  return { input, cacheRead, cacheWrite, output: usage.outputTokens ?? 0 };
}

/** Characters a step produced: answer, reasoning and tool inputs. */
function outputCharsOf(step: StepResult<ToolSet>): number {
  return (
    step.text.length +
    (step.reasoningText?.length ?? 0) +
    JSON.stringify(step.toolCalls.map((call) => call.input)).length
  );
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
  // final answer-only request (see prepareStep).
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

  // Prompt-cache breakpoints, for the providers that need them: the stable
  // system message, the last tool definition, and the growing conversation
  // (request level).
  const cache = cacheControlFor(runtime.provider);
  const instructions: SystemModelMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        projectName: turn.projectName,
        environmentName: turn.environmentName,
        sources: resolved.prompt,
        userName: turn.userName,
        orgContext: runtime.orgContext,
      }),
      ...(cache ? { providerOptions: cache } : {}),
    },
    { role: "system", content: buildVolatileSystemNote(now()) },
  ];
  const attachments: AttachmentRef[] = parseAttachmentRefs(turn.attachmentIds);
  const toolContext: ToolContext = {
    snaps: resolved.snaps,
    viewer,
    attachments,
  };
  // Set by prepareStep for the step about to run.
  let capped = false;
  let promptChars = 0;
  // A tool call that could not be audited ends the turn.
  let auditError: unknown;
  const abort = new AbortController();

  const tools = buildTools(
    toolContext,
    async (call) => {
      try {
        await recordToolCall(
          turn.messageId,
          call.tool,
          call.input,
          call.resultMeta
        );
      } catch (error) {
        auditError ??= error;
        abort.abort(error);
        throw error;
      }
    },
    { execute: deps.executeTool, lastToolProviderOptions: cache }
  );
  const toolsChars = JSON.stringify(
    Object.entries(tools).map(([name, t]) => [name, t.description])
  ).length;
  const instructionsChars = JSON.stringify(instructions).length;

  const result = streamText({
    model: runtime.model,
    instructions,
    messages: buildHistory(turn),
    tools,
    toolChoice: "auto",
    maxOutputTokens: MAX_TOKENS,
    providerOptions: mergeProviderOptions(
      providerOptionsFor(runtime.provider, runtime.effort),
      cache
    ),
    abortSignal: abort.signal,
    stopWhen: stepCountIs(MAX_ITERATIONS),
    prepareStep: async ({ stepNumber, messages }) => {
      promptChars =
        instructionsChars + toolsChars + JSON.stringify(messages).length;
      let note: string | undefined;
      // Never more than one request past the cap: with tool choice none the
      // capped step either answers (the loop ends) or its tool calls are a
      // ToolChoiceViolationError.
      if (stepNumber > 0 && (await capReached())) {
        capped = true;
        note = DAILY_CAP_NOTE;
      } else if (stepNumber === MAX_ITERATIONS - 1) {
        note = STEP_LIMIT_NOTE;
      }
      if (!note) return {};
      // The same tools keep the cached prefix; "none" makes it answer.
      return {
        toolChoice: "none",
        messages: [...messages, { role: "user", content: note }],
      };
    },
    onStepEnd: async (step) => {
      const reported = reportedUsage(step);
      await recordUsage({
        messageId: turn.messageId,
        userId: turn.userId,
        modelId: step.response.modelId || runtime.modelId,
        prices: runtime.prices,
        usage: reported ?? estimateUsage(promptChars, outputCharsOf(step)),
        estimated: !reported,
        now: now(),
      });
    },
    // Errors are read from the stream below; the default logs them.
    onError: () => {},
  });

  let streamError: unknown;
  for await (const part of result.fullStream) {
    switch (part.type) {
      case "text-delta":
        writer.append(part.text);
        break;
      case "finish-step":
        // Text of a step that asked for tools is not the answer (R11).
        if (part.finishReason === "tool-calls") writer.discard();
        break;
      case "error":
        streamError ??= part.error;
        break;
    }
  }
  if (auditError) throw auditError;
  if (ToolChoiceViolationError.isInstance(streamError)) {
    // Asked for tools on the final (tool choice none) step; the SDK runs none.
    throw new TurnError(
      capped ? "assistant.daily_cap_reached" : "assistant.too_many_steps"
    );
  }
  if (streamError) throw streamError;

  const last = (await result.steps).at(-1);
  switch (last?.finishReason) {
    case "stop":
      return;
    case "content-filter":
      throw new TurnError("assistant.refused");
    case "tool-calls":
      // Out of steps while still calling tools.
      throw new TurnError(
        capped ? "assistant.daily_cap_reached" : "assistant.too_many_steps"
      );
    default:
      // A truncated answer or tool input, a context overflow, or a reason
      // the provider does not map.
      console.error(
        `[assistant] turn ${turn.messageId} stopped: ${last?.rawFinishReason ?? last?.finishReason}`
      );
      throw new TurnError("assistant.failed");
  }
}
