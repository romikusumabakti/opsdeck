import { UI_MESSAGE_STREAM_HEADERS } from "ai";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { uuidSchema } from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  conversationIdInputSchema,
  createConversation,
  createConversationInputSchema,
  createJiraIssue,
  deleteConversation,
  draftIdInputSchema,
  editQuestion,
  editQuestionInputSchema,
  generateConversationDraft,
  generateDraftInputSchema,
  getAllowance,
  getConversation,
  listConversations,
  listConversationsInputSchema,
  listDraftProjects,
  listIssueAttachmentsForPicker,
  pinConversation,
  pinConversationInputSchema,
  renameConversation,
  renameConversationInputSchema,
  retryAnswer,
  saveDraft,
  saveDraftInputSchema,
  sendMessage,
  sendMessageInputSchema,
  stopAnswer,
} from "@/server/services/assistant";
import {
  deleteUpload,
  fileTooLarge,
  UPLOAD_BODY_LIMIT,
  uploadFile,
  uploadGate,
} from "@/server/services/assistant-files";
import { openAnswerStream } from "@/server/services/assistant-stream";
import { json, query } from "@/server/validation";

/** The assistant's chats. Each service function authorizes the caller. */
export const assistantRouter = sessionRouter()
  .get("/allowance", async (c) => c.json(await getAllowance()))
  // The caller's own conversations, all projects: `{ pinned, recent }`,
  // never a temporary chat; `query` searches titles and message text.
  .get("/list-conversations", query(listConversationsInputSchema), async (c) =>
    c.json(await listConversations(c.req.valid("query")))
  )
  // `{ temporary: true }` for a temporary chat.
  .post(
    "/create-conversation",
    json(createConversationInputSchema),
    async (c) => c.json(await createConversation(c.req.valid("json")))
  )
  .post("/pin-conversation", json(pinConversationInputSchema), async (c) => {
    const { conversationId, pinned } = c.req.valid("json");
    return c.json(await pinConversation(conversationId, pinned));
  })
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
  // The running answer ends as failed (assistant.stopped), keeping its text.
  .post("/stop-answer", json(conversationIdInputSchema), async (c) =>
    c.json(await stopAnswer(c.req.valid("json").conversationId))
  )
  // Replaces the last answer with a new one to the same question.
  .post("/retry-answer", json(conversationIdInputSchema), async (c) =>
    c.json(await retryAnswer(c.req.valid("json").conversationId))
  )
  // Replaces the last question's text and its answer (stop a running one first).
  .post("/edit-last-question", json(editQuestionInputSchema), async (c) =>
    c.json(await editQuestion(c.req.valid("json")))
  )
  .post("/send-message", json(sendMessageInputSchema), async (c) =>
    c.json(await sendMessage(c.req.valid("json")))
  )
  /**
   * One file for the next question (multipart, field `file`) →
   * `{ id, filename, mediaType, size }`. The gate runs first, then the body
   * is capped before it is parsed, so an oversized request is a 413 without
   * being buffered whole.
   */
  .post(
    "/upload",
    uploadGate,
    bodyLimit({
      maxSize: UPLOAD_BODY_LIMIT,
      onError: async () => {
        throw await fileTooLarge();
      },
    }),
    async (c) =>
      c.json(
        await uploadFile(async () => {
          const form = await c.req.raw.formData().catch(() => null);
          const file = form?.get("file");
          return file instanceof File ? file : null;
        })
      )
  )
  // The caller's own upload, while no question carries it.
  .delete("/upload/:id", async (c) => {
    const id = c.req.param("id");
    await deleteUpload(id);
    return c.json({ id });
  })
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
   * The live answer of a chat as an AI SDK UI message stream, from its first
   * chunk (lib/assistant/turn-stream.ts); 204 when none is running.
   */
  .get("/answer-stream", query(conversationIdInputSchema), async (c) => {
    const stream = await openAnswerStream(c.req.valid("query").conversationId);
    if (!stream) return c.body(null, 204);
    return new Response(stream.pipeThrough(new TextEncoderStream()), {
      headers: {
        ...UI_MESSAGE_STREAM_HEADERS,
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    });
  });
