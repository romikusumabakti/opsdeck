import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type { UploadSummary } from "@/lib/assistant/file-store";
import {
  ApiError,
  api,
  apiErrorOf,
  NO_REFETCH,
  type PostJson,
} from "@/web/api/client";

// The assistant's chats. Every call returns plain data, so a refusal
// rejects with an ApiError (rule 2 of web/api/client.ts's error contract):
// a refused send carries `code` (`assistant.busy`, …) and, for the daily cap,
// `params` `{ resetsAt }`, worded with the `assistantErrors` messages.

const routes = api.api.assistant;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function getAllowance() {
  return parseResponse(routes.allowance.$get());
}

export const getAllowanceQuery = () =>
  queryOptions({
    queryKey: ["assistant", "getAllowance"],
    queryFn: getAllowance,
  });

/**
 * The caller's conversations, all projects, newest first, each with the
 * label of its latest question's context (`lastContextLabel`).
 */
export async function listConversations() {
  return parseResponse(routes["list-conversations"].$get());
}

export const listConversationsQuery = () =>
  queryOptions({
    queryKey: ["assistant", "listConversations"],
    queryFn: listConversations,
  });

export async function getConversation(conversationId: string) {
  return parseResponse(
    routes["get-conversation"].$get({ query: { conversationId } })
  );
}

export const getConversationQuery = (
  ...args: Parameters<typeof getConversation>
) =>
  queryOptions({
    queryKey: ["assistant", "getConversation", args],
    queryFn: () => getConversation(...args),
  });

/** The attachments of an issue in any of the caller's visible projects. */
export async function listIssueAttachments(issueKey: string) {
  return parseResponse(
    routes["list-issue-attachments"].$get({ query: { issueKey } })
  );
}

export const listIssueAttachmentsQuery = (
  ...args: Parameters<typeof listIssueAttachments>
) =>
  queryOptions({
    queryKey: ["assistant", "listIssueAttachments", args],
    queryFn: () => listIssueAttachments(...args),
  });

/** A new conversation (no project); each question then picks its context. */
export async function createConversation() {
  return parseResponse(routes["create-conversation"].$post());
}

/** Renames the caller's chat (1..80 characters, one line). */
export async function renameConversation(input: Body<"rename-conversation">) {
  return parseResponse(routes["rename-conversation"].$post({ json: input }));
}

/**
 * Deletes the caller's chat with its messages, drafts and files. Without the
 * refetch of every active query: the open chat's read would only come back
 * 404. The caller drops that read and refreshes the chat lists itself.
 */
export async function deleteConversation(conversationId: string) {
  return parseResponse(
    routes["delete-conversation"].$post(
      { json: { conversationId } },
      NO_REFETCH
    )
  );
}

/**
 * Sends a question. `context` is what it asks about: `{ kind: "auto" }`, a
 * pinned project `{ kind: "project", projectId }` (its branches) or a pinned
 * environment `{ kind: "environment", environmentId }` (its running commits).
 */
export async function sendMessage(input: Body<"send-message">) {
  return parseResponse(routes["send-message"].$post({ json: input }));
}

export type UploadedFile = UploadSummary;

/**
 * Uploads one file for the next question (POST /api/assistant/upload). Sent
 * with XMLHttpRequest, the one browser API that reports upload progress:
 * `onProgress` gets 0..1. Rejects with an ApiError (a refusal's `code`:
 * `assistant.file_too_large`, `assistant.file_type_unsupported`,
 * `assistant.too_many_files`), or an AbortError once `signal` aborts.
 */
export function uploadFile(
  file: File,
  options: {
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
  } = {}
): Promise<UploadedFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const aborted = () =>
      reject(new DOMException("The upload was aborted.", "AbortError"));
    if (options.signal?.aborted) return aborted();
    options.signal?.addEventListener("abort", () => xhr.abort(), {
      once: true,
    });
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress?.(event.loaded / event.total);
      }
    });
    xhr.addEventListener("abort", aborted);
    xhr.addEventListener("error", () =>
      reject(new ApiError(0, "Network error"))
    );
    xhr.addEventListener("load", () => {
      const response = new Response(xhr.responseText, {
        status: xhr.status,
        headers: { "Content-Type": "application/json" },
      });
      if (xhr.status >= 200 && xhr.status < 300) {
        response.json().then(resolve, reject);
      } else {
        apiErrorOf(response).then(reject, reject);
      }
    });
    const body = new FormData();
    body.set("file", file);
    xhr.open("POST", "/api/assistant/upload");
    xhr.send(body);
  });
}

/** Removes an upload no question carries yet (a chip's remove). */
export async function deleteUpload(id: string) {
  return parseResponse(
    routes.upload[":id"].$delete({ param: { id } }, NO_REFETCH)
  );
}

/** Has the model write a BRD or Jira draft from the conversation. */
export async function generateDraft(input: Body<"generate-draft">) {
  return parseResponse(routes["generate-draft"].$post({ json: input }));
}

/**
 * The projects a draft can be filed in (the caller's visible ones, by name),
 * each with its own Jira write-back switch and the caller's issue:write.
 */
export async function listDraftProjects() {
  return parseResponse(routes["draft-projects"].$get());
}

export const listDraftProjectsQuery = () =>
  queryOptions({
    queryKey: ["assistant", "listDraftProjects"],
    queryFn: listDraftProjects,
  });

/**
 * Saves the user's edit, with the project chosen for the draft
 * (`projectId`, omitted: unchanged); refused once a Jira draft became an
 * issue, 404 for a project the caller does not see.
 */
export async function saveDraft(input: Body<"save-draft">) {
  return parseResponse(routes["save-draft"].$post({ json: input }));
}

/**
 * Creates the Jira issue of a Jira draft in the draft's project (needs one
 * chosen, with a push-enabled link).
 */
export async function createJiraIssue(
  draftId: Body<"create-jira-issue">["draftId"]
) {
  return parseResponse(
    routes["create-jira-issue"].$post({ json: { draftId } })
  );
}

/** The URL of an assistant message's SSE stream, for an EventSource. */
export function messageStreamUrl(messageId: string): string {
  return `/api/assistant/stream?messageId=${encodeURIComponent(messageId)}`;
}

export type Allowance = Awaited<ReturnType<typeof getAllowance>>;
export type Conversation = Awaited<ReturnType<typeof getConversation>>;
export type ConversationMessage = Conversation["messages"][number];
export type ConversationDraft = Conversation["drafts"][number];
export type DraftProjectOption = Awaited<
  ReturnType<typeof listDraftProjects>
>[number];
/** A user message's context; null on assistant messages. */
export type MessageContext = NonNullable<ConversationMessage["context"]>;
export type ConversationSummary = Awaited<
  ReturnType<typeof listConversations>
>[number];
export type IssueAttachmentList = Awaited<
  ReturnType<typeof listIssueAttachments>
>;
