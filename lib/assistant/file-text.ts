import mammoth from "mammoth";
import { xlsxToText } from "./attachment-text";
import type { PdfWorkerRequest, PdfWorkerResponse } from "./pdf-text-worker";
import { MAX_UPLOAD_TEXT_CHARS, type UploadKind } from "./upload-types";
import { zipWithinBounds } from "./zip-bounds";

/**
 * The text the model reads in place of an uploaded file: a PDF's text
 * (for a model that cannot read PDFs), a Word document's raw text, a
 * workbook as CSV per sheet (attachment-text.ts), or a text file as is.
 * At most MAX_UPLOAD_TEXT_CHARS characters, with `truncated` set when cut.
 * A file past a bound (a PDF that does not finish in PDF_TIMEOUT_MS, a ZIP
 * outside zip-bounds.ts) throws ExtractionLimitError.
 */

/** Wall-clock bound of one PDF's extraction; the worker is then killed. */
export const PDF_TIMEOUT_MS = 15_000;
/** Pages of a PDF read at most. */
export const MAX_PDF_PAGES = 300;

/** The file is too large or too complex to read within the bounds. */
export class ExtractionLimitError extends Error {
  constructor(readonly reason: "timeout" | "zip") {
    super(`extraction bound: ${reason}`);
    this.name = "ExtractionLimitError";
  }
}

/**
 * The worker script: its source next to this file in development and
 * tests, the separately built `pdf-text-worker.js` next to the server
 * bundle in production.
 */
const PDF_WORKER_URL = new URL(
  import.meta.url.endsWith(".ts")
    ? "./pdf-text-worker.ts"
    : "./pdf-text-worker.js",
  import.meta.url
);

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

/**
 * A PDF's text, read in a worker thread (pdf-text-worker.ts) that is
 * terminated after `timeoutMs`: pdf.js on a hostile file cannot hold the
 * assistant worker. Pages past MAX_PDF_PAGES are not read.
 */
export function pdfToText(
  bytes: Uint8Array,
  options: {
    maxChars?: number;
    maxPages?: number;
    timeoutMs?: number;
    workerUrl?: URL;
  } = {}
): Promise<ExtractedText> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(options.workerUrl ?? PDF_WORKER_URL);
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new ExtractionLimitError("timeout"));
    }, options.timeoutMs ?? PDF_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    worker.onmessage = (event: MessageEvent<PdfWorkerResponse>) => {
      done();
      const result = event.data;
      if (result.ok)
        resolve({ text: result.text, truncated: result.truncated });
      else reject(new Error("the PDF could not be read"));
    };
    worker.onerror = () => {
      done();
      reject(new Error("the PDF worker failed"));
    };
    // A copy, moved to the worker (pdf.js detaches what it is given).
    const copy = new Uint8Array(bytes);
    const request: PdfWorkerRequest = {
      bytes: copy,
      maxChars: options.maxChars ?? MAX_UPLOAD_TEXT_CHARS,
      maxPages: options.maxPages ?? MAX_PDF_PAGES,
    };
    worker.postMessage(request, [copy.buffer]);
  });
}

export async function docxToText(bytes: Uint8Array): Promise<string> {
  // extractRawText never follows external links (mammoth's
  // externalFileAccess defaults to off).
  const { value } = await mammoth.extractRawText({ buffer: view(bytes) });
  return value;
}

async function requireZipBounds(bytes: Uint8Array): Promise<void> {
  if (!(await zipWithinBounds(bytes))) throw new ExtractionLimitError("zip");
}

/**
 * Throws when the file cannot be parsed as its kind, ExtractionLimitError
 * when it is past a bound.
 */
export async function extractUploadText(
  bytes: Uint8Array,
  kind: Exclude<UploadKind, "image">,
  maxChars = MAX_UPLOAD_TEXT_CHARS
): Promise<ExtractedText> {
  switch (kind) {
    case "pdf":
      return pdfToText(bytes, { maxChars });
    case "docx":
      await requireZipBounds(bytes);
      return cap(await docxToText(bytes), maxChars);
    case "xlsx": {
      await requireZipBounds(bytes);
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
