// Type-only import: `@/lib/explorer` is server-only, but the type is erased at
// compile time so nothing from it reaches the client bundle.
import type { ExplorerSource } from "@/lib/explorer";

// Client-side upload plumbing for the storage explorer: turning a drop or a
// file picker into a flat list of files-with-destinations, then pushing them at
// the upload route. Kept out of the component so the traversal rules (which are
// fiddly and browser-specific) are readable on their own.

export type PendingUpload = {
  file: File;
  // Path relative to the destination directory, for a folder upload. Undefined
  // means "store under the file's own name in the destination".
  relativePath?: string;
};

// How many files are in flight at once. Uploads are one request per file, so
// this is the knob that keeps a 500-file folder from opening 500 sockets; three
// is enough to hide per-request latency without starving the rest of the app.
const UPLOAD_CONCURRENCY = 3;

// Files chosen through <input type="file">. A directory picker
// (webkitdirectory) additionally fills in webkitRelativePath — "dist/app.js" —
// which is exactly the layout we want to recreate remotely.
export function pendingFromInput(files: FileList | null): PendingUpload[] {
  return Array.from(files ?? []).map((file) => {
    const rel = (file as File & { webkitRelativePath?: string })
      .webkitRelativePath;
    return rel ? { file, relativePath: rel } : { file };
  });
}

// Files dropped from the OS. `dataTransfer.files` alone flattens a dropped
// folder to nothing, so the entries are walked instead.
//
// The DataTransferItem list is only valid for the duration of the drop handler,
// so every webkitGetAsEntry() call happens synchronously up front; the returned
// FileSystemEntry objects stay usable afterwards and the async walk runs on
// those. webkitGetAsEntry is the interoperable API here — getAsFileSystemHandle
// is still Chromium-only.
export async function pendingFromDrop(
  dataTransfer: DataTransfer
): Promise<PendingUpload[]> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  // No entry API (or a synthetic drop): fall back to the flat file list.
  if (entries.length === 0) {
    return Array.from(dataTransfer.files).map((file) => ({ file }));
  }
  const out: PendingUpload[] = [];
  for (const entry of entries) {
    await walkEntry(entry, "", out);
  }
  return out;
}

async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: PendingUpload[]
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject);
    });
    out.push(
      prefix ? { file, relativePath: `${prefix}/${entry.name}` } : { file }
    );
    return;
  }
  if (!entry.isDirectory) return;
  const dirPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // readEntries yields at most ~100 entries per call and signals the end with
  // an empty batch, so a big directory needs repeated reads.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    for (const child of batch) {
      await walkEntry(child, dirPrefix, out);
    }
  }
}

export type UploadResult = { uploaded: number; failed: number };

// Push every pending file at the upload route, at most UPLOAD_CONCURRENCY at a
// time. Individual failures are counted rather than thrown so one unwritable
// file doesn't abandon the other 499.
export async function uploadAll(
  source: ExplorerSource,
  destDir: string,
  items: PendingUpload[],
  onProgress: (done: number, total: number) => void
): Promise<UploadResult> {
  const total = items.length;
  const queue = [...items];
  let done = 0;
  let failed = 0;

  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      const ok = await uploadOne(source, destDir, item);
      if (!ok) failed++;
      done++;
      onProgress(done, total);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(UPLOAD_CONCURRENCY, total) }, worker)
  );
  return { uploaded: done - failed, failed };
}

async function uploadOne(
  source: ExplorerSource,
  destDir: string,
  item: PendingUpload
): Promise<boolean> {
  const body = new FormData();
  body.set("source", JSON.stringify(source));
  body.set("path", destDir);
  body.set("file", item.file);
  if (item.relativePath) body.set("relativePath", item.relativePath);
  try {
    const res = await fetch("/api/explorer/upload", { method: "POST", body });
    return res.ok;
  } catch {
    return false;
  }
}
