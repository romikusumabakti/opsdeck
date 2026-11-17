import { z } from "zod";
import {
  ATTACHMENT_ID_PATTERN,
  formatAttachmentRef,
  JIRA_KEY_PATTERN,
} from "@/lib/assistant/attachment-refs";
import {
  type AssistantRuntime,
  loadAssistantRuntime,
} from "@/lib/assistant/client";
import {
  type QuestionContext,
  type QuestionContextInput,
  questionContextInputSchema,
} from "@/lib/assistant/context";
import {
  type ConversationDetail,
  type ConversationOwner,
  type ConversationSummary,
  type CreatedTurn,
  failQueuedMessage,
  findAssistantMessageConversation,
  findConversation,
  findEnvironment,
  findProject,
  insertConversation,
  insertTurn,
  listConversationsOf,
  loadAssistantLimits,
  loadConversationDetail,
} from "@/lib/assistant/conversation-store";
import {
  type DraftKind,
  type DraftOwner,
  type DraftProject,
  findDraftOwner,
  findUnlinkedRemoteOf,
  loadDraftProjects,
  suggestDraftProject,
  updateDraftContent,
} from "@/lib/assistant/draft-store";
import {
  generateDraft as defaultGenerateDraft,
  draftContentSchema,
} from "@/lib/assistant/drafts";
import {
  ASSISTANT_ERROR_MESSAGE_KEYS,
  type AssistantErrorCodeKey,
} from "@/lib/assistant/errors";
import { enqueueAssistantTurn } from "@/lib/assistant/queue";
import { classifyError } from "@/lib/assistant/run-turn";
import {
  type IssueAttachment,
  listIssueAttachments,
  normalizeJiraKey,
  visibleIssueByKey,
} from "@/lib/assistant/tools/context";
import { quotaDayResetsAt, spentTodayUsd } from "@/lib/assistant/usage";
import { loadAssistantViewer } from "@/lib/assistant/viewer";
import { requireSession } from "@/lib/auth-session";
import {
  accessibleProjectIds,
  ForbiddenError,
  getProjectAccess,
  requireProjectPermission,
} from "@/lib/authz";
import { createJiraIssueFromDraft, JiraCreateError } from "@/lib/jira/create";
import { canProject } from "@/lib/permissions";
import { uuidSchema } from "@/lib/validation";
import { CodedHTTPException, notFound } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";

/**
 * The code assistant's chat API. Every function authorizes the caller itself.
 * Conversations are global (not bound to a project) and sit behind the
 * global gate (requireAssistantGate). A conversation is visible to its owner
 * only (admins included: audit goes through the database and the usage
 * view), and another user's conversation, message or draft is a 404, so ids
 * of other users' chats reveal nothing. Each question carries a context
 * (lib/assistant/context.ts); a pinned project or environment needs
 * assistant:use on its project when the question is sent, and is checked
 * again when the turn runs (lib/assistant/run-turn.ts).
 */

export const MAX_MESSAGE_CHARS = 8000;
export const MAX_ATTACHMENTS = 10;

export const sendMessageInputSchema = z.object({
  conversationId: uuidSchema,
  text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  // What the question asks about: automatic, a pinned project (its
  // branches) or a pinned environment (its running commits). Required, so a
  // client cannot drop it by omission.
  context: questionContextInputSchema,
  // Each ticked attachment with the issue it is on, so the model can read it.
  attachments: z
    .array(
      z.strictObject({
        issueKey: z.string().regex(JIRA_KEY_PATTERN),
        attachmentId: z.string().regex(ATTACHMENT_ID_PATTERN),
      })
    )
    .max(MAX_ATTACHMENTS)
    .optional(),
});

export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

async function refusal(
  status: 400 | 409 | 422 | 429 | 502 | 503,
  code: AssistantErrorCodeKey,
  params?: { resetsAt: Date }
): Promise<CodedHTTPException> {
  const t = await getServerTranslator("assistantErrors");
  const message = t(ASSISTANT_ERROR_MESSAGE_KEYS[code], params);
  return new CodedHTTPException(
    status,
    code,
    message,
    params ? { resetsAt: params.resetsAt.toISOString() } : undefined
  );
}

/**
 * The global gate in front of every conversation: the assistant is switched
 * on with a key (else the assistant.not_configured refusal) and the caller
 * sees at least one project (else 403).
 */
async function requireAssistantGate() {
  const session = await requireSession();
  const limits = await loadAssistantLimits();
  if (!(limits.enabled && limits.hasApiKey)) {
    throw await refusal(503, "assistant.not_configured");
  }
  const visible = await accessibleProjectIds();
  if (visible !== "all" && visible.length === 0) throw new ForbiddenError();
  return session;
}

/**
 * The caller's own conversation, found by `find` once the gate passed.
 * Unknown or someone else's: 404. A conversation stays its owner's when a
 * project it asked about is lost: each question's context is checked on its
 * own (resolveQuestionContext, and again when the turn runs).
 */
async function requireOwnConversation(
  find: () => Promise<ConversationOwner | null>
): Promise<{ conversation: ConversationOwner; userId: string }> {
  const session = await requireAssistantGate();
  const conversation = await find();
  if (!conversation || conversation.userId !== session.user.id) notFound();
  return { conversation, userId: session.user.id };
}

function ownConversation(conversationId: string) {
  return requireOwnConversation(async () =>
    uuidSchema.safeParse(conversationId).success
      ? findConversation(conversationId)
      : null
  );
}

/** The caller's own conversations, all projects, newest first. */
export async function listConversations(): Promise<ConversationSummary[]> {
  const session = await requireAssistantGate();
  return listConversationsOf(session.user.id);
}

/** A new conversation; each question then picks its context. */
export async function createConversation(): Promise<{ id: string }> {
  const session = await requireAssistantGate();
  const id = await insertConversation({ userId: session.user.id });
  return { id };
}

/** requireProjectPermission with an invisible-or-forbidden project as 404. */
async function usableOr404(
  check: () => ReturnType<typeof requireProjectPermission>
): Promise<string> {
  try {
    return (await check()).projectId;
  } catch (error) {
    if (error instanceof ForbiddenError) notFound();
    throw error;
  }
}

/**
 * The context a question asks about, checked against the caller: a pinned
 * project, or a pinned environment, needs assistant:use on its project, else
 * 404 (as for a project that does not exist). Automatic needs nothing more
 * than the gate.
 */
export async function resolveQuestionContext(
  input: QuestionContextInput
): Promise<QuestionContext> {
  switch (input.kind) {
    case "auto":
      return { kind: "auto" };
    case "project": {
      await usableOr404(() =>
        requireProjectPermission(
          { projectId: input.projectId },
          { assistant: ["use"] }
        )
      );
      const project = await findProject(input.projectId);
      if (!project) notFound();
      return {
        kind: "project",
        projectId: project.id,
        projectName: project.name,
      };
    }
    case "environment": {
      const projectId = await usableOr404(() =>
        requireProjectPermission(
          { environmentId: input.environmentId },
          { assistant: ["use"] }
        )
      );
      const environment = await findEnvironment(input.environmentId);
      if (!environment || environment.projectId !== projectId) notFound();
      return {
        kind: "environment",
        environmentId: environment.id,
        environmentName: environment.name,
        projectId: environment.projectId,
        projectName: environment.projectName,
      };
    }
  }
}

/**
 * The caller's conversation. A draft's project shows only while the caller
 * sees it: one they lost reads as none, to be chosen again.
 */
export async function getConversation(
  conversationId: string
): Promise<ConversationDetail> {
  await ownConversation(conversationId);
  const detail = await loadConversationDetail(conversationId);
  if (!detail) notFound();
  const { roles } = await getProjectAccess();
  return {
    ...detail,
    drafts: detail.drafts.map((draft) => ({
      ...draft,
      projectId:
        draft.projectId && roles[draft.projectId] ? draft.projectId : null,
    })),
  };
}

/** The usable runtime, else the assistant.not_configured refusal. */
async function requireRuntime(): Promise<AssistantRuntime> {
  let runtime: AssistantRuntime | null;
  try {
    runtime = await loadAssistantRuntime();
  } catch (error) {
    // A key the current SECRETS_KEY cannot decrypt is as good as none.
    console.error("[assistant] could not load the runtime:", error);
    runtime = null;
  }
  if (!runtime) throw await refusal(503, "assistant.not_configured");
  return runtime;
}

/** Refuses once the user has spent the day's cap. */
async function requireAllowance(
  userId: string,
  runtime: { dailyCapUsd: number },
  now: Date
): Promise<void> {
  const spent = await spentTodayUsd(userId, now);
  if (spent >= runtime.dailyCapUsd) {
    throw await refusal(429, "assistant.daily_cap_reached", {
      resetsAt: quotaDayResetsAt(now),
    });
  }
}

/**
 * Stores the question with its context and a queued answer, then queues the
 * turn. A pinned project or environment must be one the caller may use the
 * assistant on, else 404. Refuses when the assistant is off or has no usable
 * key, when the caller has spent the day's cap, or while the conversation's
 * previous answer is still running.
 */
export async function sendMessage(
  input: SendMessageInput
): Promise<CreatedTurn> {
  const { conversation, userId } = await ownConversation(input.conversationId);
  const context = await resolveQuestionContext(input.context);

  const now = new Date();
  await requireAllowance(userId, await requireRuntime(), now);

  const turn = await insertTurn({
    conversationId: conversation.id,
    text: input.text,
    // Stored as `KEY:id` (lib/assistant/attachment-refs.ts), deduplicated.
    attachmentIds: [
      ...new Set((input.attachments ?? []).map(formatAttachmentRef)),
    ],
    context,
    now,
  });
  if (turn === "busy") throw await refusal(409, "assistant.busy");
  // Deleted between the check above and the insert.
  if (turn === "context_gone") notFound();

  // After the commit, so the worker always finds the rows it is given.
  try {
    await enqueueAssistantTurn(turn.assistantMessageId);
  } catch (error) {
    console.error("[assistant] could not enqueue the turn:", error);
    await failQueuedMessage(turn.assistantMessageId, "assistant.unavailable");
    throw await refusal(503, "assistant.unavailable");
  }
  return turn;
}

/** Authorizes the stream of an assistant message before it opens. */
export async function authorizeMessageStream(messageId: string): Promise<void> {
  await requireOwnConversation(async () =>
    uuidSchema.safeParse(messageId).success
      ? findAssistantMessageConversation(messageId)
      : null
  );
}

export type Allowance = {
  /** Switched on by an admin and holding an API key. */
  enabled: boolean;
  /** Share of today's limit spent, 0..1. A cap of 0 reads as fully used. */
  usedFraction: number;
  capReached: boolean;
  /** The next quota-day start (APP_TIMEZONE midnight), ISO. */
  resetsAt: string;
};

/**
 * The caller's daily allowance as a share of the limit, never in dollars
 * (admins see those on Admin > Assistant); any signed-in user may ask (no
 * project).
 */
export async function getAllowance(): Promise<Allowance> {
  const session = await requireSession();
  const now = new Date();
  const [limits, spent] = await Promise.all([
    loadAssistantLimits(),
    spentTodayUsd(session.user.id, now),
  ]);
  const cap = limits.dailyCapUsd;
  const usedFraction = cap > 0 ? Math.min(1, Math.max(0, spent / cap)) : 1;
  return {
    enabled: limits.enabled && limits.hasApiKey,
    usedFraction: Math.round(usedFraction * 1e4) / 1e4,
    // Same test as requireAllowance, which refuses the send.
    capReached: spent >= cap,
    resetsAt: quotaDayResetsAt(now).toISOString(),
  };
}

export type IssueAttachmentList = {
  key: string;
  attachments: IssueAttachment[];
  /** True when Jira could not list them (no link, sync off, Jira error). */
  unavailable: boolean;
};

/**
 * The attachments of a Jira issue the caller can see, for the tick list under
 * the question box. Behind the global gate; the issue is looked up among the
 * caller's visible projects, the same rule and listing as the get_issue tool
 * (a question may be about any of them, or automatic).
 */
export async function listIssueAttachmentsForPicker(
  issueKey: string
): Promise<IssueAttachmentList> {
  const session = await requireAssistantGate();
  const key = normalizeJiraKey(issueKey);
  if (!key) notFound();
  const viewer = await loadAssistantViewer(session.user.id);
  const visible = await visibleIssueByKey(viewer, key);
  if (!visible) notFound();
  const { attachments, error } = await listIssueAttachments(visible);
  return { key, attachments, unavailable: error !== null };
}

// --- drafts -----------------------------------------------------------------

export const generateDraftInputSchema = z.object({
  conversationId: uuidSchema,
  kind: z.enum(["brd", "jira"]),
});

export const saveDraftInputSchema = z.object({
  draftId: uuidSchema,
  // Checked against the draft's own kind in saveDraft.
  content: z.record(z.string(), z.unknown()),
  // The project the draft's issue goes to; omitted keeps the current one.
  projectId: uuidSchema.optional(),
});

export const draftIdInputSchema = z.object({ draftId: uuidSchema });

/** HTTP status of each code a draft request can fail with. */
const DRAFT_FAILURE_STATUS: Partial<
  Record<AssistantErrorCodeKey, 409 | 422 | 502 | 503>
> = {
  "assistant.not_configured": 503,
  "assistant.credit_exhausted": 503,
  "assistant.unavailable": 503,
  "assistant.model_no_drafts": 503,
  "assistant.refused": 422,
  "assistant.nothing_to_draft": 409,
  "assistant.failed": 502,
};

/** The caller's own draft, by its conversation; otherwise 404. */
async function ownDraft(
  draftId: string
): Promise<{ draft: DraftOwner; userId: string }> {
  const found: { draft?: DraftOwner } = {};
  const { userId } = await requireOwnConversation(async () => {
    if (!uuidSchema.safeParse(draftId).success) return null;
    found.draft = (await findDraftOwner(draftId)) ?? undefined;
    return found.draft?.conversation ?? null;
  });
  if (!found.draft) notFound();
  return { draft: found.draft, userId };
}

export type GenerateDraftDeps = {
  generateDraft?: typeof defaultGenerateDraft;
};

/**
 * Writes a BRD or Jira draft from the caller's conversation: one metered
 * request, refused like a message when the assistant is off or the day's cap
 * is spent.
 */
export async function generateConversationDraft(
  input: z.infer<typeof generateDraftInputSchema>,
  deps: GenerateDraftDeps = {}
): Promise<{ draftId: string }> {
  const { conversation, userId } = await ownConversation(input.conversationId);
  const runtime = await requireRuntime();
  await requireAllowance(userId, runtime, new Date());
  // Preselected for the user to confirm or change; never a project the
  // caller cannot see.
  const { roles } = await getProjectAccess();
  const projectId = await suggestDraftProject(
    conversation.id,
    (id) => roles[id] !== undefined
  );
  try {
    return await (deps.generateDraft ?? defaultGenerateDraft)(
      conversation.id,
      input.kind as DraftKind,
      userId,
      { runtime, projectId }
    );
  } catch (error) {
    const code = classifyError(error, { phase: "draft" });
    if (code === "assistant.failed") {
      console.error("[assistant] draft generation failed:", error);
    } else {
      // The code only: provider text can echo request details.
      console.warn(
        `[assistant] draft not written: ${code} (${(error as Error)?.name ?? "unknown"})`
      );
    }
    throw await refusal(DRAFT_FAILURE_STATUS[code] ?? 502, code);
  }
}

export type DraftProjectOption = DraftProject & {
  /** The caller has issue:write on it (creating the issue needs it). */
  canCreateIssue: boolean;
};

/**
 * The projects a draft can be filed in: the caller's visible projects, by
 * name, each with its own Jira write-back switch and the caller's issue
 * right, behind the global gate.
 */
export async function listDraftProjects(): Promise<DraftProjectOption[]> {
  await requireAssistantGate();
  const { roles } = await getProjectAccess();
  const projects = await loadDraftProjects(Object.keys(roles));
  return projects.map((project) => ({
    ...project,
    canCreateIssue: canProject(roles[project.id] ?? null, {
      issue: ["write"],
    }),
  }));
}

/** Saves the user's edit of a draft, validated against its kind's shape. */
export async function saveDraft(
  input: z.infer<typeof saveDraftInputSchema>
): Promise<{ id: string }> {
  const { draft } = await ownDraft(input.draftId);
  const parsed = draftContentSchema(draft.kind).safeParse(input.content);
  if (!parsed.success) throw await refusal(400, "assistant.invalid_draft");
  // Only an issue draft has a project; one sent with a BRD draft is ignored.
  const projectId = draft.kind === "jira" ? input.projectId : undefined;
  if (projectId) {
    // A chosen project must be one the caller sees (else 404, as unknown).
    await usableOr404(() =>
      requireProjectPermission({ projectId }, { assistant: ["use"] })
    );
  }
  if (draft.issueId)
    throw await refusal(409, "assistant.draft_already_created");
  if (projectId && projectId !== draft.projectId) {
    // A Jira issue an earlier create left unlinked belongs to the project
    // it was created in: the draft stays there until the retry links it.
    const unlinked = await findUnlinkedRemoteOf(input.draftId);
    if (unlinked && projectId !== (unlinked.projectId ?? draft.projectId)) {
      throw await refusal(409, "assistant.draft_project_locked");
    }
  }
  if (!(await updateDraftContent(input.draftId, parsed.data, { projectId }))) {
    throw await refusal(409, "assistant.draft_already_created");
  }
  return { id: input.draftId };
}

/**
 * Creates the Jira issue of the caller's Jira draft in the draft's project
 * (chosen on the draft), with that project's Jira link. Besides owning the
 * conversation, the caller needs issue:write on it: the issue lands in the
 * Panel's issue list too. A draft without a project is refused until one is
 * chosen.
 */
export async function createJiraIssue(
  input: z.infer<typeof draftIdInputSchema>
): Promise<{ issueId: string; jiraKey: string }> {
  const { draft, userId } = await ownDraft(input.draftId);
  if (draft.kind !== "jira")
    throw await refusal(400, "assistant.invalid_draft");
  if (!draft.projectId) {
    throw await refusal(400, "assistant.draft_project_required");
  }
  await requireProjectPermission(
    { projectId: draft.projectId },
    { issue: ["write"] }
  );
  if (draft.issueId)
    throw await refusal(409, "assistant.draft_already_created");
  try {
    // The project just authorised: a draft moved since is refused.
    return await createJiraIssueFromDraft(
      input.draftId,
      userId,
      draft.projectId
    );
  } catch (error) {
    if (error instanceof JiraCreateError) {
      throw await refusal(
        error.code === "assistant.invalid_draft" ||
          error.code === "assistant.draft_project_required"
          ? 400
          : 409,
        error.code
      );
    }
    console.error("[assistant] Jira issue creation failed:", error);
    throw await refusal(502, "assistant.jira_create_failed");
  }
}
