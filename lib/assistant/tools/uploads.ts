import { getObjectBytes } from "@/lib/storage";
import type { ImageMediaType } from "../attachment-text";
import type { UploadRef } from "../file-store";
import { extractUploadText } from "../file-text";
import { redactSecretLines } from "../secret-filter";
import {
  kindOfMediaType,
  MAX_UPLOAD_TEXT_CHARS,
  uploadLimit,
} from "../upload-types";
import type { ToolMeta, ToolResult } from "./code";
import type { AttachmentContent } from "./context";

/**
 * read_upload: one file uploaded with a question of this chat. Images and
 * PDFs go to a model that reads files natively as file parts; a model that
 * cannot (an OpenAI-compatible endpoint) gets a PDF's text and, for an
 * image, MODEL_NO_IMAGES. Other files are read as text, at most
 * MAX_UPLOAD_TEXT_CHARS, with lines holding credentials redacted.
 */

/** The tool text an OpenAI-compatible model gets for an image. */
export const MODEL_NO_IMAGES =
  "This model cannot view images. Tell the user that you could not see the image and ask them to describe it or paste its text.";

function fail(error: string, meta: ToolMeta = {}): ToolResult<never> {
  return { ok: false, error, meta };
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "base64"
  );
}

export async function readUploadTool(
  uploads: readonly UploadRef[],
  nativeFiles: boolean,
  fileId: string
): Promise<ToolResult<AttachmentContent>> {
  const id = fileId.trim();
  // Only the files of this chat's questions (loaded for the turn, the
  // chat owner's own): any other id is refused, existing or not.
  const file = uploads.find((u) => u.id === id);
  if (!file) {
    return fail(
      `file ${id} was not uploaded in this chat; use a file_id listed with a question`
    );
  }
  const meta: ToolMeta = { fileIds: [file.id] };
  const kind = kindOfMediaType(file.mediaType);

  if (kind === "image" && !nativeFiles) {
    return { ok: true, data: { kind: "text", text: MODEL_NO_IMAGES }, meta };
  }

  let bytes: Uint8Array;
  try {
    bytes = await getObjectBytes(file.storageKey, uploadLimit(kind));
  } catch (error) {
    console.error(`[assistant] could not read upload ${file.id}:`, error);
    return fail("the file could not be read from storage", meta);
  }

  if (kind === "image") {
    return {
      ok: true,
      data: {
        kind: "image",
        // Sniffed at upload (upload-types.ts): png, jpeg, gif or webp.
        mediaType: file.mediaType as ImageMediaType,
        base64: base64(bytes),
      },
      meta,
    };
  }
  if (kind === "pdf" && nativeFiles) {
    return {
      ok: true,
      data: {
        kind: "document",
        mediaType: "application/pdf",
        base64: base64(bytes),
      },
      meta,
    };
  }

  let extracted: { text: string; truncated: boolean };
  try {
    extracted = await extractUploadText(bytes, kind);
  } catch {
    return fail(`the file ${file.filename} could not be read as ${kind}`, meta);
  }
  const { text, redacted } = redactSecretLines(extracted.text);
  const note = extracted.truncated
    ? `\n\n[truncated: the file's text exceeds ${MAX_UPLOAD_TEXT_CHARS} characters]`
    : "";
  return {
    ok: true,
    data: { kind: "text", text: `# ${file.filename}\n\n${text}${note}` },
    meta: {
      ...meta,
      ...(extracted.truncated ? { truncated: true } : {}),
      ...(redacted > 0 ? { withheld: redacted } : {}),
    },
  };
}
