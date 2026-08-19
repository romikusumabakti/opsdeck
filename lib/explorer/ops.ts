import "server-only";

import { basename, joinPath } from "./path";
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

// A path in a selection that no longer exists. Distinct from a generic failure
// so callers can say "gone" instead of "storage error".
export class MissingEntryError extends Error {}

// Fold a selection of paths — files, folders, or a mix — into one archive-shaped
// tree. `flat` keeps a lone directory's contents at the root (the "download this
// folder" shape); otherwise every target is nested under its own name, which is
// also what stops a mixed selection from colliding.
export async function collectSelection(
  backend: StorageBackend,
  targets: string[],
  flat: boolean
): Promise<Tree> {
  const tree: Tree = { files: [], emptyDirs: [] };
  for (const target of targets) {
    const prefix = flat ? "" : basename(target);
    if (target === "" || target.endsWith("/")) {
      const sub = await collectTree(backend, target);
      for (const file of sub.files) {
        tree.files.push({
          ...file,
          relPath: prefix ? `${prefix}/${file.relPath}` : file.relPath,
        });
      }
      for (const empty of sub.emptyDirs) {
        tree.emptyDirs.push(prefix ? `${prefix}/${empty}` : empty);
      }
      // A selected folder that holds nothing still belongs in the archive;
      // collectTree only reports empty dirs it finds *below* its own root.
      if (prefix && sub.files.length === 0 && sub.emptyDirs.length === 0) {
        tree.emptyDirs.push(`${prefix}/`);
      }
    } else {
      const info = await backend.stat(target);
      if (!info) throw new MissingEntryError(target);
      tree.files.push({
        path: target,
        relPath: prefix,
        sizeBytes: info.sizeBytes,
        modifiedAt: info.modifiedAt,
      });
    }
    // collectTree bounds each walk on its own; the selection as a whole needs
    // the same ceiling applied across all of them.
    if (tree.files.length > MAX_TREE_ENTRIES) {
      throw new TreeTooLargeError(`Tree exceeds ${MAX_TREE_ENTRIES} entries`);
    }
  }
  return tree;
}

// A name that is free inside `destDir`. Copying an entry next to itself is the
// common case, so the fallbacks read like a file manager's: "notes (copy).txt",
// then "notes (copy 2).txt". Bounded — past that, the caller gets the last try
// and the backend decides.
export async function uniqueName(
  backend: StorageBackend,
  destDir: string,
  name: string,
  isDir: boolean
): Promise<string> {
  const taken = new Set((await backend.list(destDir)).map((e) => e.name));
  if (!taken.has(name)) return name;
  // Only files carry a meaningful extension; a dot in a folder name is part of
  // the name, not a suffix.
  const dot = isDir ? -1 : name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 100; i++) {
    const candidate = `${stem} (copy${i > 1 ? ` ${i}` : ""})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem} (copy 100)${ext}`;
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
