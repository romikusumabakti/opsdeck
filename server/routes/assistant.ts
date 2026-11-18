import { z } from "zod";
import { readStreamSnapshot } from "@/lib/assistant/conversation-store";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  authorizeMessageStream,
  conversationIdInputSchema,
  createConversation,
  createJiraIssue,
  deleteConversation,
  draftIdInputSchema,
  generateConversationDraft,
  generateDraftInputSchema,
  getAllowance,
  getConversation,
  listConversations,
  listDraftProjects,
  listIssueAttachmentsForPicker,
  renameConversation,
  renameConversationInputSchema,
  saveDraft,
  saveDraftInputSchema,
  sendMessage,
  sendMessageInputSchema,
} from "@/server/services/assistant";
import { eventStream, pollSnapshots, sendEvent } from "@/server/sse";
import { json, query } from "@/server/validation";

// The stream polls Postgres, where the worker writes the answer as it streams
// (lib/assistant/turn-store.ts). Capped like the run streams: EventSource
// reconnects, which also frees sockets held by vanished tabs.
const STREAM_POLL_INTERVAL_MS = 500;
const STREAM_MAX_DURATION_MS = 10 * 60 * 1000;

/** The assistant's chats. Each service function authorizes the caller. */
export const assistantRouter = sessionRouter()
  .get("/allowance", async (c) => c.json(await getAllowance()))
  // The caller's own conversations, all projects; a new one has no project.
  .get("/list-conversations", async (c) => c.json(await listConversations()))
  .post("/create-conversation", async (c) => c.json(await createConversation()))
  .get(
    "/get-conversation",
    query(z.object({ conversationId: uuidSchema })),
    async (c) =>
      c.json(await getConversation(c.req.valid("query").conversationId))
  )
  .post(
    "/rename-conversation",
    json(renameConversationInputSchema),
    async (c) => {
      const { conversationId, title } = c.req.valid("json");
      await renameConversation(conversationId, title);
      return c.json({ id: conversationId });
    }
  )
  // With its messages, drafts and files; a running answer stops.
  .post("/delete-conversation", json(conversationIdInputSchema), async (c) => {
    const { conversationId } = c.req.valid("json");
    await deleteConversation(conversationId);
    return c.json({ id: conversationId });
  })
  .post("/send-message", json(sendMessageInputSchema), async (c) =>
    c.json(await sendMessage(c.req.valid("json")))
  )
  // Drafts: written by the model from the conversation, edited by the user, and
  // (Jira drafts) created as an issue on an explicit request.
  .post("/generate-draft", json(generateDraftInputSchema), async (c) =>
    c.json(await generateConversationDraft(c.req.valid("json")))
  )
  // The projects a draft can be filed in, each with its push switch.
  .get("/draft-projects", async (c) => c.json(await listDraftProjects()))
  .post("/save-draft", json(saveDraftInputSchema), async (c) =>
    c.json(await saveDraft(c.req.valid("json")))
  )
  .post("/create-jira-issue", json(draftIdInputSchema), async (c) =>
    c.json(await createJiraIssue(c.req.valid("json")))
  )
  .get(
    "/list-issue-attachments",
    query(z.object({ issueKey: z.string().max(64) })),
    async (c) => {
      const { issueKey } = c.req.valid("query");
      return c.json(await listIssueAttachmentsForPicker(issueKey));
    }
  )
  /**
   * One assistant message as SSE: a `snapshot` event (content, status,
   * errorCode, toolCalls) on every change, ending once it is done or failed.
   */
  .get("/stream", query(z.object({ messageId: uuidSchema })), async (c) => {
    const { messageId } = c.req.valid("query");
    // Before the stream opens: once it has, the status is 200 for good.
    await authorizeMessageStream(messageId);
    return eventStream(c, (stream) =>
      pollSnapshots(stream, {
        intervalMs: STREAM_POLL_INTERVAL_MS,
        maxDurationMs: STREAM_MAX_DURATION_MS,
        logLabel: "assistant stream snapshot",
        read: async () => {
          const snapshot = await readStreamSnapshot(messageId);
          if (!snapshot) {
            await sendEvent(stream, "not-found", { id: messageId });
            return undefined;
          }
          return {
            snapshot,
            done: snapshot.status === "done" || snapshot.status === "failed",
          };
        },
      })
    );
  });
