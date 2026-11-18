import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { xlsxToText } from "./attachment-text";
import { MAX_UPLOAD_TEXT_CHARS, type UploadKind } from "./upload-types";

/**
 * The text the model reads in place of an uploaded file: a PDF's text
 * (for a model that cannot read PDFs), a Word document's raw text, a
 * workbook as CSV per sheet (attachment-text.ts), or a text file as is.
 * At most MAX_UPLOAD_TEXT_CHARS characters, with `truncated` set when cut.
 */

export type ExtractedText = { text: string; truncated: boolean };

function cap(text: string, maxChars: number): ExtractedText {
  // Code points, so a cut never splits a surrogate pair.
  const chars = Array.from(text);
  if (chars.length <= maxChars) return { text, truncated: false };
  return { text: chars.slice(0, maxChars).join(""), truncated: true };
}

function view(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export async function pdfToText(bytes: Uint8Array): Promise<string> {
  // pdf.js takes ownership of (detaches) the buffer it is given: a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

export async function docxToText(bytes: Uint8Array): Promise<string> {
  // extractRawText never follows external links (mammoth's
  // externalFileAccess defaults to off).
  const { value } = await mammoth.extractRawText({ buffer: view(bytes) });
  return value;
}

/** Throws when the file cannot be parsed as its kind. */
export async function extractUploadText(
  bytes: Uint8Array,
  kind: Exclude<UploadKind, "image">,
  maxChars = MAX_UPLOAD_TEXT_CHARS
): Promise<ExtractedText> {
  switch (kind) {
    case "pdf":
      return cap(await pdfToText(bytes), maxChars);
    case "docx":
      return cap(await docxToText(bytes), maxChars);
    case "xlsx": {
      // UTF-8 bytes bound characters, so 4 bytes per character always covers
      // maxChars; the workbook's own marker is kept when it truncated.
      const sheet = await xlsxToText(bytes, maxChars * 4);
      const capped = cap(sheet.text, maxChars);
      return {
        text: capped.text,
        truncated: capped.truncated || sheet.truncated,
      };
    }
    case "text":
      return cap(new TextDecoder("utf-8").decode(bytes), maxChars);
  }
}
