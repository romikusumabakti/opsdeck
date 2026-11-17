import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { api, type PostJson } from "@/web/api/client";

// The code assistant chat. Every call returns plain data, so a refusal
// rejects with an ApiError (rule 2 of web/api/client.ts's error contract):
// a refused send carries `code` (`assistant.busy`, …) and, for the daily cap,
// `params` `{ capUsd, resetsAt }`, worded with the `assistantErrors` messages.

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

/** The caller's conversations about a project, newest first. */
export async function listConversations(projectId: string) {
  return parseResponse(
    routes["list-conversations"].$get({ query: { projectId } })
  );
}

export const listConversationsQuery = (
  ...args: Parameters<typeof listConversations>
) =>
  queryOptions({
    queryKey: ["assistant", "listConversations", args],
    queryFn: () => listConversations(...args),
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

export async function listIssueAttachments(
  projectId: string,
  issueKey: string
) {
  return parseResponse(
    routes["list-issue-attachments"].$get({
      query: { projectId, issueKey },
    })
  );
}

export const listIssueAttachmentsQuery = (
  ...args: Parameters<typeof listIssueAttachments>
) =>
  queryOptions({
    queryKey: ["assistant", "listIssueAttachments", args],
    queryFn: () => listIssueAttachments(...args),
  });

/** A new project conversation; each question then picks its source. */
export async function createConversation(input: Body<"create-conversation">) {
  return parseResponse(routes["create-conversation"].$post({ json: input }));
}

/**
 * Sends a question. `environmentId` is the source it asks about: an
 * environment of the conversation's project, or null for the project branches.
 */
export async function sendMessage(input: Body<"send-message">) {
  return parseResponse(routes["send-message"].$post({ json: input }));
}

/** Has the model write a BRD or Jira draft from the conversation. */
export async function generateDraft(input: Body<"generate-draft">) {
  return parseResponse(routes["generate-draft"].$post({ json: input }));
}

/** Saves the user's edit; refused once a Jira draft became an issue. */
export async function saveDraft(input: Body<"save-draft">) {
  return parseResponse(routes["save-draft"].$post({ json: input }));
}

/** Creates the Jira issue of a Jira draft (needs a push-enabled link). */
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
export type ConversationSummary = Awaited<
  ReturnType<typeof listConversations>
>[number];
export type IssueAttachmentList = Awaited<
  ReturnType<typeof listIssueAttachments>
>;
