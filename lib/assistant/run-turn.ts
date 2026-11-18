import {
  APICallError,
  type ContentPart,
  type LanguageModel,
  type LanguageModelUsage,
  LoadAPIKeyError,
  type ModelMessage,
  RetryError,
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
import { CHARS_PER_TOKEN, estimateUsage, type TokenUsage } from "./pricing";
import { resolveProjectSources as defaultResolveProjectSources } from "./project-sources";
import {
  cacheControlFor,
  outputTokenLimitFor,
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
  buildSourceNote,
  buildSystemPrompt,
  buildVolatileSystemNote,
  type PromptSource,
  type QuestionSource,
  questionContextLabel,
} from "./system-prompt";
import {
  buildTools,
  type ListedProject,
  type ToolContext,
  type ToolExecutor,
} from "./tool-defs";
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
import {
  type AssistantViewer,
  loadAssistantViewer,
  loadProjectEntries,
  type ProjectEntry,
  viewerSees,
  visibleProjects,
} from "./viewer";

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
  | "assistant.context_gone"
  | "assistant.failed";

export type RunTurnDeps = {
  /** Replaces the runtime's model (tests inject a mock). */
  model?: LanguageModel;
  now?: () => Date;
  loadRuntime?: () => Promise<AssistantRuntime | null>;
  /** The running sources of an environment. */
  resolveSources?: (environmentId: string) => Promise<AssistantSource[]>;
  /** The project branches. */
  resolveProjectSources?: (projectId: string) => Promise<AssistantSource[]>;
  ensureSnapshot?: (source: AssistantSource) => Promise<Snapshot>;
  /** Every project (an automatic question filters them by the viewer). */
  loadProjects?: () => Promise<ProjectEntry[]>;
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
// A 429 is a rate limit unless it names an exhausted balance or a daily quota;
// per-minute quotas ("… quota … Please retry in 30s") stay transient.
const EXHAUSTED_BALANCE = /insufficient_quota|credit balance|PerDay/i;
const TRANSIENT_LIMIT = /retry|per.?minute|PerMinute/i;
const MENTIONS_API_KEY = /api[_ ]?key/i;
const TOOLS_FUNCTIONALITY = /tool|function/i;
const STRUCTURED_FUNCTIONALITY = /response.?format|structured|json/i;
// A structured-output (draft) request the model or endpoint cannot serve.
const NO_STRUCTURED_SUPPORT =
  /(response_format|json_schema|json mode|structured outputs?)\b[^.]*\b(is |are )?(not supported|unsupported)|does not support (response_format|json_schema|json mode|structured outputs?)/i;
const NO_TOOL_SUPPORT =
  /does not support (tools|tool use|tool calling|function calling)|(tools?|tool use|tool calling|function calling) (are|is) not supported/i;

/**
 * Where the error happened. Only a draft asks for structured output, so only
 * there does a structured-output error mean the model cannot write drafts.
 */
export type ErrorPhase = "turn" | "draft";

/**
 * Maps an error thrown by the SDK (or the loop, or a draft) to the stable
 * error code.
 */
export function classifyError(
  error: unknown,
  { phase = "turn" }: { phase?: ErrorPhase } = {}
): AssistantErrorCode {
  if (error instanceof TurnError) return error.code;
  if (RetryError.isInstance(error)) {
    return classifyError(error.lastError, { phase });
  }
  if (LoadAPIKeyError.isInstance(error)) return "assistant.not_configured";
  if (UnsupportedFunctionalityError.isInstance(error)) {
    if (
      phase === "draft" &&
      STRUCTURED_FUNCTIONALITY.test(error.functionality)
    ) {
      return "assistant.model_no_drafts";
    }
    return TOOLS_FUNCTIONALITY.test(error.functionality)
      ? "assistant.model_no_tools"
      : "assistant.failed";
  }
  const failure = providerFailureOf(error);
  if (!failure) return "assistant.failed";
  const { status, text } = failure;
  if (status === 401 || status === 403) return "assistant.not_configured";
  if (
    status === 402 ||
    (status === 400 && MENTIONS_BILLING.test(text)) ||
    (status === 429 &&
      EXHAUSTED_BALANCE.test(text) &&
      !TRANSIENT_LIMIT.test(text))
  ) {
    return "assistant.credit_exhausted";
  }
  if (status === 400 && MENTIONS_API_KEY.test(text)) {
    return "assistant.not_configured";
  }
  if (status === 400 && NO_TOOL_SUPPORT.test(text)) {
    return "assistant.model_no_tools";
  }
  if (phase === "draft" && status === 400 && NO_STRUCTURED_SUPPORT.test(text)) {
    return "assistant.model_no_drafts";
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
 * (the API merges them). Each earlier question starts with the short label of
 * the source it asked about; the question being answered carries
 * `sourceNote` as its first part instead. So nothing before that question
 * depends on its source, and the cached history holds across source switches.
 */
export function buildHistory(
  turn: TurnContext,
  sourceNote: string
): ModelMessage[] {
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
    if (index !== lastUserIndex) {
      messages.push({
        role: "user",
        content: `${questionContextLabel(m.context)}\n${m.content}`,
      });
      return;
    }
    let text = m.content;
    if (ticked.length > 0) {
      const list = ticked
        .map(
          (a) => `- issue_key ${a.issueKey}, attachment_id ${a.attachmentId}`
        )
        .join("\n");
      text += `\n\n(Attachments ticked for this question, readable with read_attachment:\n${list})`;
    }
    messages.push({
      role: "user",
      content: [
        { type: "text", text: sourceNote },
        { type: "text", text },
      ],
    });
  });
  return messages;
}

type ResolvedSources = QuestionSources & {
  prompt: PromptSource[];
  snaps: SnapshotRef[];
};

/**
 * The question and the sources read up front (pinned), or the projects the
 * viewer can see (automatic, read lazily).
 */
type QuestionSources = {
  question: QuestionSource;
  sources: AssistantSource[];
  projects: ProjectEntry[];
};

type SourceDeps = Required<
  Pick<
    RunTurnDeps,
    | "resolveSources"
    | "resolveProjectSources"
    | "ensureSnapshot"
    | "loadProjects"
  >
>;

/**
 * The source the turn's question asked about, from its user message: the
 * running commits of its environment, the branches of its project, or
 * nothing up front for an automatic question. The pinned project is checked
 * against the user's access again, as at send time: a question whose project
 * the user lost since, or whose project or environment was deleted, cannot
 * be answered as asked.
 */
async function resolveQuestionSources(
  turn: TurnContext,
  viewer: AssistantViewer,
  deps: SourceDeps
): Promise<QuestionSources> {
  const { context } = turn;
  switch (context.kind) {
    case "gone":
      throw new TurnError(
        context.of === "environment"
          ? "assistant.environment_gone"
          : "assistant.context_gone"
      );
    case "auto": {
      const projects = visibleProjects(viewer, await deps.loadProjects());
      return { question: { kind: "auto", projects }, sources: [], projects };
    }
    case "project":
      if (!viewerSees(viewer, context.projectId)) {
        throw new TurnError("assistant.context_gone");
      }
      return {
        question: { kind: "project", projectName: context.projectName },
        sources: await deps.resolveProjectSources(context.projectId),
        projects: [],
      };
    case "environment":
      if (!viewerSees(viewer, context.projectId)) {
        throw new TurnError("assistant.context_gone");
      }
      return {
        question: {
          kind: "environment",
          environmentName: context.environmentName,
          projectName: context.projectName,
        },
        sources: await deps.resolveSources(context.environmentId),
        projects: [],
      };
  }
}

/**
 * Downloads (or finds in the cache) the snapshot of each source, in
 * parallel, keeping their order: the prompt line of each (with the commit
 * read, or why it is unavailable) and the snapshots the tools may read.
 */
async function snapshotSources(
  sources: AssistantSource[],
  ensureSnapshot: SourceDeps["ensureSnapshot"]
): Promise<{ prompt: PromptSource[]; snaps: SnapshotRef[] }> {
  // Downloads run in parallel; the order of the sources is kept.
  type Outcome =
    | { source: AssistantSource; snap: Snapshot }
    | { source: AssistantSource; reason: string };
  const outcomes = await Promise.all(
    sources.map(async (source): Promise<Outcome> => {
      try {
        return { source, snap: await ensureSnapshot(source) };
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

async function resolveSnapshots(
  turn: TurnContext,
  viewer: AssistantViewer,
  deps: SourceDeps
): Promise<ResolvedSources> {
  const resolved = await resolveQuestionSources(turn, viewer, deps);
  return {
    ...resolved,
    ...(await snapshotSources(resolved.sources, deps.ensureSnapshot)),
  };
}

/** A source as stored on the answer: unavailable ones keep a null commit. */
function storedSource({
  unavailableReason,
  ...source
}: PromptSource): AssistantSource {
  return unavailableReason ? { ...source, commitSha: null } : source;
}

/** Projects whose sources list_projects resolves at once. */
const LIST_PROJECTS_CONCURRENCY = 4;

/**
 * The cached promise for `key`, else a new one from `load`. A rejected
 * promise is dropped, so a transient failure can be retried in the turn.
 */
function memoised<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>
): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = load();
  cache.set(key, pending);
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}

/** `fn` over `items` with at most `limit` running at once; order kept. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

/**
 * The automatic context's project access for one turn. A key resolves only
 * against the viewer's visible projects (`projects`, already filtered); each
 * project's sources are resolved, and its snapshots fetched, once per turn
 * however many calls name it. The sources of every project opened are
 * written to the answer as they are opened, tagged with their project, so
 * the answer lists what was read even if the turn fails later; a read waits
 * for that write.
 */
function projectAccess(
  messageId: string,
  projects: ProjectEntry[],
  deps: SourceDeps
): Pick<
  Extract<ToolContext, { mode: "auto" }>,
  "snapshotsFor" | "listProjects"
> {
  const byKey = new Map(projects.map((p) => [p.key, p]));
  const sourcesOf = new Map<string, Promise<AssistantSource[]>>();
  const snapsOf = new Map<string, Promise<SnapshotRef[]>>();
  let opened: AssistantSource[] = [];
  let saving: Promise<void> = Promise.resolve();

  const sources = (project: ProjectEntry) =>
    memoised(sourcesOf, project.id, () =>
      deps.resolveProjectSources(project.id)
    );

  const open = async (project: ProjectEntry): Promise<SnapshotRef[]> => {
    const { prompt, snaps } = await snapshotSources(
      await sources(project),
      deps.ensureSnapshot
    );
    const tagged = prompt.map((source) => ({
      ...storedSource(source),
      projectKey: project.key,
      projectName: project.name,
    }));
    // Chained, so writes run one at a time and each extends the last list
    // written. A project joins the list only once its write succeeded: a
    // failed write fails its own read, and the retried load adds it again
    // without a duplicate.
    const write = saving
      .catch(() => {})
      .then(async () => {
        const next = [...opened, ...tagged];
        await saveSources(messageId, next);
        opened = next;
      });
    saving = write;
    await write;
    return snaps;
  };

  return {
    snapshotsFor: (projectKey) => {
      const project = byKey.get(projectKey);
      if (!project) return Promise.resolve({ error: "unknown_project" });
      return memoised(snapsOf, project.id, () => open(project));
    },
    listProjects: () =>
      mapLimit(
        projects,
        LIST_PROJECTS_CONCURRENCY,
        async (project): Promise<ListedProject> => ({
          key: project.key,
          name: project.name,
          description: project.description,
          components: (await sources(project)).map((s) => s.componentKey),
        })
      ),
  };
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
export function mergeProviderOptions(
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
export function reportedUsage(usage: LanguageModelUsage): TokenUsage | null {
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
export function outputCharsOf(
  content: ReadonlyArray<ContentPart<ToolSet>>
): number {
  let chars = 0;
  for (const part of content) {
    if (part.type === "text" || part.type === "reasoning") {
      chars += part.text.length;
    } else if (part.type === "tool-call") {
      chars += JSON.stringify(part.input ?? null).length;
    }
  }
  return chars;
}

/** Input tokens a provider typically charges for one image. */
export const IMAGE_TOKEN_ALLOWANCE = 1_600;
/** The most input tokens one PDF is estimated at. */
export const PDF_TOKEN_CAP = 100_000;

/**
 * The prompt's size in characters for a usage estimate. File parts (an
 * attachment read with read_attachment) count as a token allowance, not as
 * their base64 text: an image as IMAGE_TOKEN_ALLOWANCE, a PDF scaled by its
 * size up to PDF_TOKEN_CAP.
 */
export function promptCharsOf(value: unknown): number {
  let fileChars = 0;
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (!isFilePart(item)) return item;
    const base64 = typeof item.data.data === "string" ? item.data.data : "";
    const tokens = item.mediaType.startsWith("image/")
      ? IMAGE_TOKEN_ALLOWANCE
      : Math.min(Math.ceil((base64.length * 3) / 4 / 3), PDF_TOKEN_CAP);
    fileChars += tokens * CHARS_PER_TOKEN;
    return { type: item.type, mediaType: item.mediaType };
  });
  return (json?.length ?? 0) + fileChars;
}

function isFilePart(
  item: unknown
): item is { type: string; mediaType: string; data: { data?: unknown } } {
  if (typeof item !== "object" || item === null) return false;
  const part = item as Record<string, unknown>;
  return (
    (part.type === "file" || part.type === "image-data") &&
    typeof part.mediaType === "string" &&
    typeof part.data === "object" &&
    part.data !== null
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
  const sourceDeps: SourceDeps = {
    resolveSources: deps.resolveSources ?? defaultResolveSources,
    resolveProjectSources:
      deps.resolveProjectSources ?? defaultResolveProjectSources,
    ensureSnapshot:
      deps.ensureSnapshot ?? ((source) => defaultEnsureSnapshot(source)),
    loadProjects: deps.loadProjects ?? loadProjectEntries,
  };
  const resolved = await resolveSnapshots(turn, viewer, sourceDeps);
  // Stored without the turn-only unavailableReason. An automatic question
  // starts empty; the projects it opens are added as it reads them.
  await saveSources(turn.messageId, resolved.prompt.map(storedSource));

  // Prompt-cache breakpoints, for the providers that need them: the stable
  // system message, the last tool definition, and the growing conversation
  // (request level). The question's source travels with the question
  // (buildHistory), so switching it keeps the system message and the
  // replayed history cached.
  const cache = cacheControlFor(runtime.provider);
  const instructions: SystemModelMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        userName: turn.userName,
        preferredName: turn.preferredName,
        orgContext: runtime.orgContext,
      }),
      ...(cache ? { providerOptions: cache } : {}),
    },
    { role: "system", content: buildVolatileSystemNote(now()) },
  ];
  const attachments: AttachmentRef[] = parseAttachmentRefs(turn.attachmentIds);
  const toolContext: ToolContext =
    resolved.question.kind === "auto"
      ? {
          mode: "auto",
          viewer,
          attachments,
          ...projectAccess(turn.messageId, resolved.projects, sourceDeps),
        }
      : { mode: "pinned", snaps: resolved.snaps, viewer, attachments };
  // Set by prepareStep for the step about to run.
  let capped = false;
  let promptChars = 0;
  let stepMetered = false;
  // A tool call that could not be audited ends the turn.
  let auditError: unknown;
  const abort = new AbortController();
  const audit = (
    tool: string,
    input: unknown,
    resultMeta: Record<string, unknown>
  ) =>
    recordToolCall(
      turn.messageId,
      tool,
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : { input },
      resultMeta
    );

  const tools = buildTools(
    toolContext,
    async (call) => {
      try {
        await audit(call.tool, call.input, call.resultMeta);
      } catch (error) {
        console.error("[assistant] failed to audit a tool call", error);
        auditError ??= error;
        abort.abort();
        // The tool error the SDK makes of this reaches the model: no
        // internal text in it.
        throw new Error("audit failed");
      }
    },
    { execute: deps.executeTool, lastToolProviderOptions: cache }
  );
  const toolsChars = JSON.stringify(
    Object.entries(tools).map(([name, t]) => [name, t.description])
  ).length;
  const instructionsChars = promptCharsOf(instructions);

  const meter = (
    modelId: string,
    usage: LanguageModelUsage,
    content: ReadonlyArray<ContentPart<ToolSet>>
  ) => {
    stepMetered = true;
    const reported = reportedUsage(usage);
    return recordUsage({
      messageId: turn.messageId,
      userId: turn.userId,
      modelId: modelId || runtime.modelId,
      prices: runtime.prices,
      usage: reported ?? estimateUsage(promptChars, outputCharsOf(content)),
      estimated: !reported,
      now: now(),
    });
  };

  const result = streamText({
    model: runtime.model,
    instructions,
    messages: buildHistory(
      turn,
      buildSourceNote({ source: resolved.question, sources: resolved.prompt })
    ),
    tools,
    toolChoice: "auto",
    maxOutputTokens: outputTokenLimitFor(runtime.provider),
    providerOptions: mergeProviderOptions(
      providerOptionsFor(runtime.provider, runtime.effort),
      cache
    ),
    abortSignal: abort.signal,
    stopWhen: stepCountIs(MAX_ITERATIONS),
    prepareStep: async ({ stepNumber, messages }) => {
      stepMetered = false;
      promptChars = instructionsChars + toolsChars + promptCharsOf(messages);
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
    // Metered as soon as the model call ends, before its tools run, so a turn
    // that fails in a tool (an audit failure) still pays for the call.
    onLanguageModelCallEnd: async (event) => {
      await meter(event.modelId, event.usage, event.content);
    },
    onStepEnd: async (step) => {
      // A call that ended in a stream error reaches no call end.
      if (!stepMetered) {
        await meter(step.response.modelId, step.usage, step.content);
      }
      // Calls the SDK rejected (unknown tool, input not matching the schema)
      // never reach execute; audited here, with no result.
      for (const call of step.toolCalls) {
        if (call.invalid)
          await audit(call.toolName, call.input, { invalid: true });
      }
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
