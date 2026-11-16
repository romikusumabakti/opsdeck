import { z } from "zod";
import {
  type AssistantRuntime,
  loadAssistantRuntime,
} from "@/lib/assistant/client";
import {
  type ConversationDetail,
  type ConversationOwner,
  type ConversationSummary,
  type CreatedTurn,
  environmentNameOf,
  failQueuedMessage,
  findAssistantMessageConversation,
  findConversation,
  insertConversation,
  insertTurn,
  listConversationsOf,
  loadAssistantLimits,
  loadConversationDetail,
} from "@/lib/assistant/conversation-store";
import {
  type DraftKind,
  type DraftOwner,
  findDraftOwner,
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
import { ForbiddenError, requireProjectPermission } from "@/lib/authz";
import { createJiraIssueFromDraft, JiraCreateError } from "@/lib/jira/create";
import { uuidSchema } from "@/lib/validation";
import { CodedHTTPException, notFound } from "@/server/errors";
import { getServerTranslator } from "@/server/i18n";

/**
 * The code assistant's chat API. Every function authorizes the caller itself:
 * project assistant:use for an environment, and for a conversation or message
 * both ownership and assistant:use on the conversation's project. A
 * conversation is visible to its owner only (admins included: audit goes
 * through the database and the usage view), and anything the caller may not
 * see is a 404, never a 403, so ids of other users' chats reveal nothing.
 */

export const MAX_MESSAGE_CHARS = 8000;
export const MAX_ATTACHMENTS = 10;

export const sendMessageInputSchema = z.object({
  conversationId: uuidSchema,
  text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
  // Jira attachment ids are numeric strings.
  attachmentIds: z
    .array(z.string().regex(/^[1-9][0-9]{0,18}$/))
    .max(MAX_ATTACHMENTS)
    .optional(),
});

export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

async function refusal(
  status: 400 | 409 | 422 | 429 | 502 | 503,
  code: AssistantErrorCodeKey,
  params?: { capUsd: number; resetsAt: Date }
): Promise<CodedHTTPException> {
  const t = await getServerTranslator("assistantErrors");
  const message = t(ASSISTANT_ERROR_MESSAGE_KEYS[code], params);
  return new CodedHTTPException(
    status,
    code,
    message,
    params
      ? { capUsd: params.capUsd, resetsAt: params.resetsAt.toISOString() }
      : undefined
  );
}

/**
 * The caller's own conversation on a project they can still ask about, found
 * by `find` once the session is known. Unknown, someone else's, or on a
 * project they lost: 404.
 */
async function requireOwnConversation(
  find: () => Promise<ConversationOwner | null>
): Promise<{ conversation: ConversationOwner; userId: string }> {
  const session = await requireSession();
  const conversation = await find();
  if (!conversation || conversation.userId !== session.user.id) notFound();
  try {
    await requireProjectPermission(
      { projectId: conversation.projectId },
      { assistant: ["use"] }
    );
  } catch (error) {
    if (error instanceof ForbiddenError) notFound();
    throw error;
  }
  return { conversation, userId: session.user.id };
}

function ownConversation(conversationId: string) {
  return requireOwnConversation(async () =>
    uuidSchema.safeParse(conversationId).success
      ? findConversation(conversationId)
      : null
  );
}

export async function listConversations(
  environmentId: string
): Promise<ConversationSummary[]> {
  const { session } = await requireProjectPermission(
    { environmentId },
    { assistant: ["use"] }
  );
  return listConversationsOf(session.user.id, environmentId);
}

export async function createConversation(
  environmentId: string
): Promise<{ id: string }> {
  const { session, projectId } = await requireProjectPermission(
    { environmentId },
    { assistant: ["use"] }
  );
  const environmentName = await environmentNameOf(environmentId);
  if (environmentName === null) notFound();
  const id = await insertConversation({
    userId: session.user.id,
    projectId,
    environmentId,
    environmentName,
  });
  return { id };
}

export async function getConversation(
  conversationId: string
): Promise<ConversationDetail> {
  await ownConversation(conversationId);
  const detail = await loadConversationDetail(conversationId);
  if (!detail) notFound();
  return detail;
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
  runtime: AssistantRuntime,
  now: Date
): Promise<void> {
  const spent = await spentTodayUsd(userId, now);
  if (spent >= runtime.dailyCapUsd) {
    throw await refusal(429, "assistant.daily_cap_reached", {
      capUsd: runtime.dailyCapUsd,
      resetsAt: quotaDayResetsAt(now),
    });
  }
}

/**
 * Stores the question and a queued answer, then queues the turn. Refuses when
 * the assistant is off or has no usable key, when the caller has spent the
 * day's cap, or while the conversation's previous answer is still running.
 */
export async function sendMessage(
  input: SendMessageInput
): Promise<CreatedTurn> {
  const { conversation, userId } = await ownConversation(input.conversationId);

  const now = new Date();
  await requireAllowance(userId, await requireRuntime(), now);

  const turn = await insertTurn({
    conversationId: conversation.id,
    text: input.text,
    attachmentIds: [...new Set(input.attachmentIds ?? [])],
    now,
  });
  if (turn === "busy") throw await refusal(409, "assistant.busy");

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
  capUsd: number;
  spentUsd: number;
  remainingUsd: number;
  /** The next quota-day start (APP_TIMEZONE midnight), ISO. */
  resetsAt: string;
};

/** The caller's daily allowance; any signed-in user may ask (no project). */
export async function getAllowance(): Promise<Allowance> {
  const session = await requireSession();
  const now = new Date();
  const [limits, spent] = await Promise.all([
    loadAssistantLimits(),
    spentTodayUsd(session.user.id, now),
  ]);
  const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
  return {
    enabled: limits.enabled && limits.hasApiKey,
    capUsd: limits.dailyCapUsd,
    spentUsd: round(spent),
    remainingUsd: round(Math.max(0, limits.dailyCapUsd - spent)),
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
 * the question box. Same visibility rule and listing as the get_issue tool.
 */
export async function listIssueAttachmentsForPicker(
  environmentId: string,
  issueKey: string
): Promise<IssueAttachmentList> {
  const { session } = await requireProjectPermission(
    { environmentId },
    { assistant: ["use"] }
  );
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
});

export const draftIdInputSchema = z.object({ draftId: uuidSchema });

/** HTTP status of each code a draft request can fail with. */
const DRAFT_FAILURE_STATUS: Partial<
  Record<AssistantErrorCodeKey, 409 | 422 | 502 | 503>
> = {
  "assistant.not_configured": 503,
  "assistant.credit_exhausted": 503,
  "assistant.unavailable": 503,
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
  try {
    return await (deps.generateDraft ?? defaultGenerateDraft)(
      conversation.id,
      input.kind as DraftKind,
      userId,
      { runtime }
    );
  } catch (error) {
    const code = classifyError(error);
    if (code === "assistant.failed") {
      console.error("[assistant] draft generation failed:", error);
    }
    throw await refusal(DRAFT_FAILURE_STATUS[code] ?? 502, code);
  }
}

/** Saves the user's edit of a draft, validated against its kind's shape. */
export async function saveDraft(
  input: z.infer<typeof saveDraftInputSchema>
): Promise<{ id: string }> {
  const { draft } = await ownDraft(input.draftId);
  const parsed = draftContentSchema(draft.kind).safeParse(input.content);
  if (!parsed.success) throw await refusal(400, "assistant.invalid_draft");
  if (draft.issueId)
    throw await refusal(409, "assistant.draft_already_created");
  if (!(await updateDraftContent(input.draftId, parsed.data))) {
    throw await refusal(409, "assistant.draft_already_created");
  }
  return { id: input.draftId };
}

/**
 * Creates the Jira issue of the caller's Jira draft. Besides owning the
 * conversation, the caller needs issue:write on its project: the issue lands
 * in the Panel's issue list too.
 */
export async function createJiraIssue(
  input: z.infer<typeof draftIdInputSchema>
): Promise<{ issueId: string; jiraKey: string }> {
  const { draft, userId } = await ownDraft(input.draftId);
  await requireProjectPermission(
    { projectId: draft.conversation.projectId },
    { issue: ["write"] }
  );
  if (draft.kind !== "jira")
    throw await refusal(400, "assistant.invalid_draft");
  if (draft.issueId)
    throw await refusal(409, "assistant.draft_already_created");
  try {
    return await createJiraIssueFromDraft(input.draftId, userId);
  } catch (error) {
    if (error instanceof JiraCreateError) {
      throw await refusal(
        error.code === "assistant.invalid_draft" ? 400 : 409,
        error.code
      );
    }
    console.error("[assistant] Jira issue creation failed:", error);
    throw await refusal(502, "assistant.jira_create_failed");
  }
}
