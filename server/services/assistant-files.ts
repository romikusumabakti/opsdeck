import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import {
  countUnsentUploads,
  deleteUnsentUpload,
  insertUpload,
  removeStoredUpload,
  type UploadSummary,
} from "@/lib/assistant/file-store";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOADS_PER_QUESTION,
  MiB,
  sniffUpload,
  uploadFilename,
  uploadLimit,
} from "@/lib/assistant/upload-types";
import { zipWithinBounds } from "@/lib/assistant/zip-bounds";
import { putObject } from "@/lib/storage";
import { uuidSchema } from "@/lib/validation";
import { notFound } from "@/server/errors";
import { refusal, requireAssistantGate } from "@/server/services/assistant";

/**
 * Files uploaded for a question (the 📎 in the question box), behind the
 * assistant's global gate like every chat call. An upload is its uploader's
 * only: stored under `assistant/<userId>/<fileId>`, unsent until a question
 * carries it (sendMessage), removable by its owner only while unsent, and
 * removed by the hourly prune (lib/assistant/upload-prune.ts) once unsent
 * for 24 h. Its type is decided by its bytes (lib/assistant/upload-types.ts),
 * its size limit by that type, and a Word document or workbook must stay
 * within the ZIP bounds (lib/assistant/zip-bounds.ts).
 */

/**
 * Unsent uploads one user may hold at once: a few questions' worth, so
 * abandoned boxes (a closed tab) do not block new uploads before the prune,
 * while storage stays bounded per user.
 */
export const MAX_UNSENT_UPLOADS = MAX_UPLOADS_PER_QUESTION * 3;

/** The upload route's body limit: the largest file plus multipart framing. */
export const UPLOAD_BODY_LIMIT = MAX_UPLOAD_BYTES + 64 * 1024;

/**
 * The upload route's gate, mounted before its body limit: a caller the gate
 * refuses (assistant off, no visible project) is answered before any of
 * the body is read. uploadFile checks it again, like every service call.
 */
export const uploadGate = createMiddleware(async (_c, next) => {
  await requireAssistantGate();
  await next();
});

const limitMb = (bytes: number) => Math.round(bytes / MiB);

export async function fileTooLarge(limit = MAX_UPLOAD_BYTES) {
  return refusal(413, "assistant.file_too_large", { limitMb: limitMb(limit) });
}

async function requireUnsentRoom(userId: string): Promise<void> {
  if ((await countUnsentUploads(userId)) >= MAX_UNSENT_UPLOADS) {
    throw await refusal(409, "assistant.too_many_files", {
      max: MAX_UPLOADS_PER_QUESTION,
    });
  }
}

/**
 * Stores one uploaded file for the caller. `readFile` parses the request
 * body; it runs only once the gate passed. Refused when the file is larger
 * than its type allows, of a type no question takes (or not what its name
 * says), or when the caller already holds MAX_UNSENT_UPLOADS unsent files.
 */
export async function uploadFile(
  readFile: () => Promise<File | null>
): Promise<UploadSummary> {
  const session = await requireAssistantGate();
  const userId = session.user.id;
  // Before the body is read, so a refused upload is never buffered, and
  // again after it: uploads read in parallel all pass the first check.
  await requireUnsentRoom(userId);
  const file = await readFile();
  if (!file) throw new HTTPException(400, { message: "Invalid request" });
  if (file.size > MAX_UPLOAD_BYTES) throw await fileTooLarge();
  if (file.size === 0)
    throw await refusal(415, "assistant.file_type_unsupported");
  await requireUnsentRoom(userId);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const filename = uploadFilename(file.name);
  const sniffed = sniffUpload(bytes, filename);
  if (!sniffed) throw await refusal(415, "assistant.file_type_unsupported");
  const limit = uploadLimit(sniffed.kind);
  if (bytes.byteLength > limit) throw await fileTooLarge(limit);
  // A Word document or workbook that would inflate past the bounds (a ZIP
  // bomb, or a directory that lies) is refused before it is stored.
  if (
    (sniffed.kind === "docx" || sniffed.kind === "xlsx") &&
    !(await zipWithinBounds(bytes))
  ) {
    throw await refusal(422, "assistant.file_too_complex");
  }

  const id = Bun.randomUUIDv7();
  const storageKey = `assistant/${userId}/${id}`;
  try {
    await putObject(
      storageKey,
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      sniffed.mediaType
    );
  } catch (error) {
    console.error("[assistant] upload to storage failed:", error);
    throw await refusal(502, "assistant.unavailable");
  }
  const upload = {
    id,
    filename,
    mediaType: sniffed.mediaType,
    size: bytes.byteLength,
  };
  try {
    await insertUpload({ ...upload, userId, storageKey });
  } catch (error) {
    await removeStoredUpload(storageKey);
    throw error;
  }
  return upload;
}

/** Removes the caller's own unsent upload; anything else is a 404. */
export async function deleteUpload(fileId: string): Promise<void> {
  const session = await requireAssistantGate();
  if (!uuidSchema.safeParse(fileId).success) notFound();
  const storageKey = await deleteUnsentUpload(session.user.id, fileId);
  if (!storageKey) notFound();
  await removeStoredUpload(storageKey);
}
