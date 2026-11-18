import { and, asc, count, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { assistantFiles, assistantMessages } from "@/lib/db/schema";
import { deleteObject } from "@/lib/storage";

/**
 * The Postgres side of a question's uploaded files (assistant_files). An
 * upload is its uploader's alone: unsent (message_id null) until a question
 * carries it, then part of that question's chat, deleted with it.
 */

/** What the chat shows of a file: never its storage key. */
export type UploadSummary = {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
};

/** A file the turn may read (read_upload). */
export type UploadRef = UploadSummary & { storageKey: string };

/** Unsent uploads older than this are removed by the hourly prune. */
export const UNSENT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export async function insertUpload(values: {
  id: string;
  userId: string;
  storageKey: string;
  filename: string;
  mediaType: string;
  size: number;
}): Promise<void> {
  await db.insert(assistantFiles).values(values);
}

/** How many uploads of the user no question carries yet. */
export async function countUnsentUploads(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(assistantFiles)
    .where(
      and(eq(assistantFiles.userId, userId), isNull(assistantFiles.messageId))
    );
  return row?.n ?? 0;
}

/**
 * Deletes the user's own unsent upload; its storage key, or null when there
 * is none (unknown, another user's, or already sent with a question).
 */
export async function deleteUnsentUpload(
  userId: string,
  fileId: string
): Promise<string | null> {
  const [row] = await db
    .delete(assistantFiles)
    .where(
      and(
        eq(assistantFiles.id, fileId),
        eq(assistantFiles.userId, userId),
        isNull(assistantFiles.messageId)
      )
    )
    .returning({ storageKey: assistantFiles.storageKey });
  return row?.storageKey ?? null;
}

/**
 * Deletes the unsent uploads older than UNSENT_UPLOAD_TTL_MS (compared in
 * the database, like the other sweeps); their storage keys. One attached
 * meanwhile is not matched: the row re-check sees its message_id.
 */
export async function deleteStaleUnsentUploads(): Promise<string[]> {
  const rows = await db
    .delete(assistantFiles)
    .where(
      and(
        isNull(assistantFiles.messageId),
        sql`${assistantFiles.createdAt} < now() - ${UNSENT_UPLOAD_TTL_MS} * interval '1 millisecond'`
      )
    )
    .returning({ storageKey: assistantFiles.storageKey });
  return rows.map((r) => r.storageKey);
}

/** The row is gone already: an object that cannot be removed is logged. */
export async function removeStoredUpload(storageKey: string): Promise<void> {
  try {
    await deleteObject(storageKey);
  } catch (error) {
    console.error(
      `[assistant] could not delete stored upload ${storageKey}:`,
      error
    );
  }
}

/**
 * The uploads on the user messages of a conversation up to (excluding)
 * `beforeMessageId`, of the conversation's owner only, oldest first.
 */
export async function uploadsOfConversation(
  conversationId: string,
  ownerId: string,
  beforeMessageId?: string
): Promise<Map<string, UploadRef[]>> {
  const rows = await db
    .select({
      id: assistantFiles.id,
      messageId: assistantFiles.messageId,
      filename: assistantFiles.filename,
      mediaType: assistantFiles.mediaType,
      size: assistantFiles.size,
      storageKey: assistantFiles.storageKey,
    })
    .from(assistantFiles)
    .innerJoin(
      assistantMessages,
      eq(assistantMessages.id, assistantFiles.messageId)
    )
    .where(
      and(
        eq(assistantMessages.conversationId, conversationId),
        eq(assistantFiles.userId, ownerId),
        beforeMessageId ? lt(assistantMessages.id, beforeMessageId) : undefined
      )
    )
    .orderBy(asc(assistantFiles.id));
  const byMessage = new Map<string, UploadRef[]>();
  for (const { messageId, ...file } of rows) {
    if (!messageId) continue;
    const list = byMessage.get(messageId) ?? [];
    list.push(file);
    byMessage.set(messageId, list);
  }
  return byMessage;
}

/**
 * Within the turn's transaction: attaches the user's unsent uploads to the
 * question. False (the caller rolls back) unless every id is one of them.
 */
export async function attachUploads(
  tx: Pick<typeof db, "update">,
  params: {
    userId: string;
    fileIds: string[];
    conversationId: string;
    messageId: string;
  }
): Promise<boolean> {
  if (params.fileIds.length === 0) return true;
  const attached = await tx
    .update(assistantFiles)
    .set({ messageId: params.messageId, conversationId: params.conversationId })
    .where(
      and(
        inArray(assistantFiles.id, params.fileIds),
        eq(assistantFiles.userId, params.userId),
        isNull(assistantFiles.messageId)
      )
    )
    .returning({ id: assistantFiles.id });
  return attached.length === new Set(params.fileIds).size;
}
