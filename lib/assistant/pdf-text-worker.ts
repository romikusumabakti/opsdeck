import { pdfPagesText } from "./pdf-pages";

/**
 * The PDF text worker (file-text.ts pdfToText): pdf.js runs here, off the
 * worker's event loop, so a hostile PDF can be stopped by terminating the
 * thread. Built as its own file next to the server bundle (package.json
 * build), since Bun's bundler does not follow `new Worker(...)`.
 */

declare const self: Worker;

export type PdfWorkerRequest = {
  bytes: Uint8Array;
  maxChars: number;
  maxPages: number;
};
export type PdfWorkerResponse =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false };

self.onmessage = async (event: MessageEvent<PdfWorkerRequest>) => {
  const { bytes, maxChars, maxPages } = event.data;
  let response: PdfWorkerResponse;
  try {
    response = { ok: true, ...(await pdfPagesText(bytes, maxChars, maxPages)) };
  } catch {
    response = { ok: false };
  }
  self.postMessage(response);
};
