import "server-only";

import { joinPath } from "./path";
import type { ExplorerEntry, StorageBackend } from "./types";

// Backend-neutral operations composed from the StorageBackend primitives. They
// live here rather than in each backend because they are pure orchestration:
// walking a tree and creating parent directories mean the same thing over SFTP
// and over an S3 prefix. Genuinely backend-specific recursion (S3 needs a flat
// key listing, SFTP needs depth-first rmdir) stays inside the backend.

// A ceiling on how much of a tree one request will enumerate. A folder download
// holds the whole listing in memory before streaming, and an accidental archive
// of a 10M-object bucket would take the process down; failing loudly at a known
// bound is the safer behaviour.
export const MAX_TREE_ENTRIES = 20_000;

export class TreeTooLargeError extends Error {}

export type TreeFile = {
  // Full backend path, for readStream.
  path: string;
  // Path relative to the walked root — the name the entry gets in an archive.
  relPath: string;
  sizeBytes?: number;
  modifiedAt?: Date;
};

export type Tree = {
  files: TreeFile[];
  // Directories with no files anywhere beneath them. An archive needs these
  // explicitly; a directory holding files is implied by its members' paths.
  emptyDirs: string[];
};

// Depth-first walk of everything under `dirPath` ("" = root). Directories are
// listed one at a time — parallelising would multiply SFTP round trips onto a
// single pooled channel for no real gain, since listings are already fast.
export async function collectTree(
  backend: StorageBackend,
  dirPath: string
): Promise<Tree> {
  const files: TreeFile[] = [];
  const emptyDirs: string[] = [];
  let count = 0;

  // Stack of [absolute path, path relative to the walked root].
  const stack: [string, string][] = [[dirPath, ""]];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next) break;
    const [dir, rel] = next;
    const entries: ExplorerEntry[] = await backend.list(dir);
    count += entries.length;
    if (count > MAX_TREE_ENTRIES) {
      throw new TreeTooLargeError(`Tree exceeds ${MAX_TREE_ENTRIES} entries`);
    }
    // A folder that lists as empty still belongs in the archive. S3 renders an
    // empty prefix as its zero-byte marker object, which lists as nothing.
    if (entries.length === 0 && rel) {
      emptyDirs.push(`${rel}/`);
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.type === "dir") {
        stack.push([entry.path, childRel]);
      } else {
        files.push({
          path: entry.path,
          relPath: childRel,
          sizeBytes: entry.sizeBytes,
          modifiedAt: entry.modifiedAt,
        });
      }
    }
  }

  return { files, emptyDirs };
}

// mkdir -p. Each level is attempted and failures are swallowed: the only reason
// to call this is "the destination directory may not exist yet", and the write
// that follows is the real test of whether the path is usable. On S3 every
// level is a cheap zero-byte marker; on SFTP an existing directory throws
// EEXIST, which is exactly the case we want to ignore.
export async function ensureDir(
  backend: StorageBackend,
  dirPath: string
): Promise<void> {
  const segments = dirPath.replace(/\/+$/, "").split("/").filter(Boolean);
  let cur = "";
  for (const segment of segments) {
    cur = joinPath(cur, `${segment}/`);
    try {
      await backend.mkdir(cur);
    } catch {
      // Already there (or the backend has no real directories) — keep going.
    }
  }
}
