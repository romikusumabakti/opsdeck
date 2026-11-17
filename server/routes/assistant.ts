import { z } from "zod";
import { readStreamSnapshot } from "@/lib/assistant/conversation-store";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  authorizeMessageStream,
  createConversation,
  createJiraIssue,
  draftIdInputSchema,
  generateConversationDraft,
  generateDraftInputSchema,
  getAllowance,
  getConversation,
  getLastProject,
  listConversations,
  listIssueAttachmentsForPicker,
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

const projectIdInput = z.object({ projectId: uuidSchema });

/** The code assistant chat. Each service function authorizes the caller. */
export const assistantRouter = sessionRouter()
  .get("/allowance", async (c) => c.json(await getAllowance()))
  .get("/list-conversations", query(projectIdInput), async (c) =>
    c.json(await listConversations(c.req.valid("query")))
  )
  .get("/last-project", async (c) => c.json(await getLastProject()))
  .post("/create-conversation", json(projectIdInput), async (c) =>
    c.json(await createConversation(c.req.valid("json")))
  )
  .get(
    "/get-conversation",
    query(z.object({ conversationId: uuidSchema })),
    async (c) =>
      c.json(await getConversation(c.req.valid("query").conversationId))
  )
  .post("/send-message", json(sendMessageInputSchema), async (c) =>
    c.json(await sendMessage(c.req.valid("json")))
  )
  // Drafts: written by the model from the conversation, edited by the user, and
  // (Jira drafts) created as an issue on an explicit request.
  .post("/generate-draft", json(generateDraftInputSchema), async (c) =>
    c.json(await generateConversationDraft(c.req.valid("json")))
  )
  .post("/save-draft", json(saveDraftInputSchema), async (c) =>
    c.json(await saveDraft(c.req.valid("json")))
  )
  .post("/create-jira-issue", json(draftIdInputSchema), async (c) =>
    c.json(await createJiraIssue(c.req.valid("json")))
  )
  .get(
    "/list-issue-attachments",
    query(z.object({ projectId: uuidSchema, issueKey: z.string().max(64) })),
    async (c) => {
      const { projectId, issueKey } = c.req.valid("query");
      return c.json(await listIssueAttachmentsForPicker(projectId, issueKey));
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
