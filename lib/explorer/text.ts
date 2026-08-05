import "server-only";

import { Readable } from "node:stream";
import { MAX_EDITABLE_BYTES } from "@/lib/validation";
import type { StorageBackend } from "./types";

// Text read/write for the in-browser file editor. Editing is deliberately a
// small-file feature: the whole document is buffered in memory here, shipped to
// the browser, and written back whole. Anything larger than MAX_EDITABLE_BYTES
// stays a download/upload job (the explorer routes, which stream).

// How lines are terminated in the file on disk. CodeMirror always hands back
// "\n"-joined text, so we remember the original convention and restore it on
// save — otherwise opening a CRLF file and saving it would rewrite every line.
export type Eol = "lf" | "crlf";

export type TextRead =
  | { ok: true; content: string; eol: Eol }
  | { ok: false; reason: "too-large" | "binary" };

// Read a file as UTF-8 text, refusing anything too big or not actually text.
// The size gate is enforced twice: once from stat (cheap, and the only signal
// some backends give before transfer) and again while draining, since stat can
// be missing, stale, or lie about a growing file.
export async function readTextFile(
  backend: StorageBackend,
  path: string
): Promise<TextRead> {
  const info = await backend.stat(path);
  if (info?.sizeBytes != null && info.sizeBytes > MAX_EDITABLE_BYTES) {
    return { ok: false, reason: "too-large" };
  }

  const stream = await backend.readStream(path);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_EDITABLE_BYTES) {
      // Abort the transfer instead of draining a multi-GB file into memory.
      stream.destroy();
      return { ok: false, reason: "too-large" };
    }
    chunks.push(buf);
  }
  const bytes = Buffer.concat(chunks);

  // Binary sniff. A NUL byte never appears in UTF-8 text, and `fatal` decoding
  // rejects invalid sequences — together they keep the editor from mangling a
  // binary the user opened by accident (it would round-trip as replacement
  // characters and silently corrupt the file on save).
  if (bytes.includes(0)) return { ok: false, reason: "binary" };
  let content: string;
  try {
    // ignoreBOM keeps a leading U+FEFF in the string so it survives the
    // round-trip; the default would strip it on read and drop it on save.
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes
    );
  } catch {
    return { ok: false, reason: "binary" };
  }

  return { ok: true, content, eol: content.includes("\r\n") ? "crlf" : "lf" };
}

// Write text back, restoring the file's original line endings. Overwrites in
// place: S3 PutObject replaces the object, SFTP's write stream truncates.
export async function writeTextFile(
  backend: StorageBackend,
  path: string,
  content: string,
  eol: Eol
): Promise<void> {
  const normalized =
    eol === "crlf" ? content.replace(/\r?\n/g, "\r\n") : content;
  await backend.writeStream(
    path,
    Readable.from(Buffer.from(normalized, "utf8"))
  );
}
