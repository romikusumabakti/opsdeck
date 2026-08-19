"use server";

import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth-session";
import {
  type ExplorerEntry,
  type ExplorerSource,
  resolveBackend,
} from "@/lib/explorer";
import { zipStream } from "@/lib/explorer/archive";
import {
  collectSelection,
  collectTree,
  MissingEntryError,
  TreeTooLargeError,
  uniqueName,
} from "@/lib/explorer/ops";
import {
  basename,
  isWithin,
  joinPath,
  moveDestination,
  PathError,
} from "@/lib/explorer/path";
import { type Eol, readTextFile, writeTextFile } from "@/lib/explorer/text";
import type { ActionResponse } from "@/lib/types";
import {
  explorerEolSchema,
  explorerNameSchema,
  explorerPathSchema,
  explorerSourceSchema,
  explorerTextSchema,
} from "@/lib/validation";

// Storage explorer actions. Filesystem/bucket access is powerful (SFTP runs as
// the SSH user, often root), so every entry point is admin-gated — a stricter
// bar than the requireSession used for read-only project data. Credentials are
// never in a payload: the client sends a source descriptor of ids, and
// resolveBackend loads creds server-side.

type ListResult = ActionResponse<ExplorerEntry[]>;

// Parse+authorize the common preamble. Returns the resolved backend or a
// typed error so each action can early-return.
async function open(
  source: unknown,
  t: Awaited<ReturnType<typeof getTranslations>>
) {
  const parsed = explorerSourceSchema.safeParse(source);
  if (!parsed.success) {
    return { ok: false as const, message: t("invalidInput") };
  }
  const backend = await resolveBackend(parsed.data as ExplorerSource);
  if (!backend) {
    return { ok: false as const, message: t("sourceNotFound") };
  }
  return { ok: true as const, backend };
}

// Map a thrown backend error to a user-facing message. PathError (a confinement
// violation) is surfaced distinctly; everything else is a generic failure so we
// don't leak remote paths / bucket internals.
function explain(
  error: unknown,
  t: Awaited<ReturnType<typeof getTranslations>>
): string {
  if (error instanceof PathError) return t("invalidPath");
  if (error instanceof MissingEntryError) return t("entryGone");
  if (error instanceof TreeTooLargeError) return t("treeTooLarge");
  console.error("Explorer operation failed:", error);
  return t("explorerFailed");
}

export async function listEntries(
  source: unknown,
  path: unknown
): Promise<ListResult> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const opened = await open(source, t);
  if (!opened.ok) return { success: false, message: opened.message };
  const parsedPath = explorerPathSchema.safeParse(path ?? "");
  if (!parsedPath.success) {
    return { success: false, message: t("invalidPath") };
  }
  try {
    const data = await opened.backend.list(parsedPath.data);
    return { success: true, data };
  } catch (error) {
    return { success: false, message: explain(error, t) };
  }
}

// A short-TTL presigned URL (S3) or a marker telling the client to hit the
// proxy download route (SFTP).
type DownloadResult =
  | {
      success: true;
      target: { kind: "presigned"; url: string } | { kind: "proxy" };
    }
  | { success: false; message: string };

export async function getDownloadTarget(
  source: unknown,
  path: unknown
): Promise<DownloadResult> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const opened = await open(source, t);
  if (!opened.ok) return { success: false, message: opened.message };
  const parsedPath = explorerPathSchema.safeParse(path);
  if (!parsedPath.success || !parsedPath.data) {
    return { success: false, message: t("invalidPath") };
  }
  try {
    const target = await opened.backend.downloadTarget(parsedPath.data);
    return { success: true, target };
  } catch (error) {
    return { success: false, message: explain(error, t) };
  }
}

// Editing reads/writes the whole file through the action layer instead of the
// streaming upload route: the payload is bounded (MAX_EDITABLE_BYTES) and this
// keeps the mutation on the same admin-gated, path-validated path as the rest.
type ReadTextResult =
  | { success: true; content: string; eol: Eol }
  | { success: false; message: string };

export async function readFileText(
  source: unknown,
  path: unknown
): Promise<ReadTextResult> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const opened = await open(source, t);
  if (!opened.ok) return { success: false, message: opened.message };
  const parsedPath = explorerPathSchema.safeParse(path);
  if (!parsedPath.success || !parsedPath.data) {
    return { success: false, message: t("invalidPath") };
  }
  try {
    const result = await readTextFile(opened.backend, parsedPath.data);
    if (!result.ok) {
      return {
        success: false,
        message:
          result.reason === "too-large" ? t("fileTooLarge") : t("fileNotText"),
      };
    }
    return { success: true, content: result.content, eol: result.eol };
  } catch (error) {
    return { success: false, message: explain(error, t) };
  }
}

export async function saveFileText(
  source: unknown,
  path: unknown,
  content: unknown,
  eol: unknown
): Promise<ActionResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const opened = await open(source, t);
  if (!opened.ok) return { success: false, message: opened.message };
  const parsedPath = explorerPathSchema.safeParse(path);
  const parsedContent = explorerTextSchema.safeParse(content);
  const parsedEol = explorerEolSchema.safeParse(eol);
  if (!parsedPath.success || !parsedPath.data || !parsedEol.success) {
    return { success: false, message: t("invalidInput") };
  }
  if (!parsedContent.success) {
    return { success: false, message: t("fileTooLarge") };
  }
  try {
    await writeTextFile(
      opened.backend,
      parsedPath.data,
      parsedContent.data,
      parsedEol.data
    );
    return { success: true, message: t("fileSaved") };
  } catch (error) {
    return { success: false, message: explain(error, t) };
  }
}

export async function createFolder(
  source: unknown,
  parentPath: unknown,
  name: unknown
): Promise<ActionResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const opened = await open(source, t);
  if (!opened.ok) return { success: false, message: opened.message };
  const parent = explorerPathSchema.safeParse(parentPath ?? "");
  const parsedName = explorerNameSchema.safeParse(name);
  if (!parent.success || !parsedName.success) {
    return { success: false, message: t("invalidInput") };
  }
  const base = parent.data.replace(/\/+$/, "");
  const target = base ? `${base}/${parsedName.data}/` : `${parsedName.data}/`;
  try {
    await opened.backend.mkdir(target);
    return { success: true, message: t("folderCreated") };
  } catch (error) {
    return { success: false, message: explain(error, t) };
  }
}

export async function deleteEntry(
  source: unknown,
  path: unknown
): Promise<ActionResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const opened = await open(source, t);
  if (!opened.ok) return { success: false, message: opened.message };
  const parsedPath = explorerPathSchema.safeParse(path);
  if (!parsedPath.success || !parsedPath.data) {
    return { success: false, message: t("invalidPath") };
  }
  try {
    await opened.backend.remove(parsedPath.data);
    return { success: true, message: t("entryDeleted") };
  } catch (error) {
    return { success: false, message: explain(error, t) };
  }
}

export async function renameEntry(
  source: unknown,
  path: unknown,
  newName: unknown
): Promise<ActionResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const opened = await open(source, t);
  if (!opened.ok) return { success: false, message: opened.message };
  const parsedPath = explorerPathSchema.safeParse(path);
  const parsedName = explorerNameSchema.safeParse(newName);
  if (!parsedPath.success || !parsedPath.data || !parsedName.success) {
    return { success: false, message: t("invalidInput") };
  }
  // Rename in place: swap the final segment, preserving a trailing slash so a
  // folder stays a folder.
  const isDir = parsedPath.data.endsWith("/");
  const trimmed = parsedPath.data.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  const parent = slash >= 0 ? trimmed.slice(0, slash) : "";
  const dest = `${parent ? `${parent}/` : ""}${parsedName.data}${isDir ? "/" : ""}`;
  try {
    await opened.backend.rename(parsedPath.data, dest);
    return { success: true, message: t("entryRenamed") };
  } catch (error) {
    return { success: false, message: explain(error, t) };
  }
}

// Drag-and-drop move: relocate an entry under `destDir` keeping its own name.
// Backed by the same rename primitive as the rename action — on SFTP that is a
// native rename, on S3 a prefix rewrite.
export async function moveEntry(
  source: unknown,
  path: unknown,
  destDir: unknown
): Promise<ActionResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const opened = await open(source, t);
  if (!opened.ok) return { success: false, message: opened.message };
  const parsedPath = explorerPathSchema.safeParse(path);
  const parsedDest = explorerPathSchema.safeParse(destDir ?? "");
  if (!parsedPath.success || !parsedPath.data || !parsedDest.success) {
    return { success: false, message: t("invalidPath") };
  }
  const from = parsedPath.data;
  const dest = parsedDest.data;
  // Dropping a folder on itself or on something inside it would ask the backend
  // to copy a tree into its own subtree.
  if (from.endsWith("/") && isWithin(dest, from)) {
    return { success: false, message: t("moveIntoSelf") };
  }
  const target = moveDestination(from, dest);
  // Dropped back where it already is — nothing to do, and no error either.
  if (target === from) return { success: true };
  try {
    await opened.backend.rename(from, target);
    return { success: true, message: t("entryMoved") };
  } catch (error) {
    return { success: false, message: explain(error, t) };
  }
}

// Copy an entry into `destDir`, keeping its own name unless that name is taken
// — a copy landing next to its original gets the "(copy)" treatment rather than
// overwriting it. Recursive for folders; the backend does it server-side where
// it can (S3) and streams where it can't (SFTP).
export async function copyEntry(
  source: unknown,
  path: unknown,
  destDir: unknown
): Promise<ActionResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const opened = await open(source, t);
  if (!opened.ok) return { success: false, message: opened.message };
  const parsedPath = explorerPathSchema.safeParse(path);
  const parsedDest = explorerPathSchema.safeParse(destDir ?? "");
  if (!parsedPath.success || !parsedPath.data || !parsedDest.success) {
    return { success: false, message: t("invalidPath") };
  }
  const from = parsedPath.data;
  const dest = parsedDest.data;
  const isDir = from.endsWith("/");
  // Copying a folder into its own subtree would recurse into what it is
  // writing. Same rule the move action enforces.
  if (isDir && isWithin(dest, from)) {
    return { success: false, message: t("copyIntoSelf") };
  }
  try {
    const name = await uniqueName(opened.backend, dest, basename(from), isDir);
    await opened.backend.copy(
      from,
      `${joinPath(dest, name)}${isDir ? "/" : ""}`
    );
    return { success: true, message: t("entryCopied") };
  } catch (error) {
    return { success: false, message: explain(error, t) };
  }
}

// Zip a selection into `destDir` as `name`.zip. The archive is built and
// streamed straight back into the backend — nothing lands on this machine's
// disk, and on S3 nothing but the stream itself is buffered.
export async function compressEntries(
  source: unknown,
  paths: unknown,
  destDir: unknown,
  name: unknown
): Promise<ActionResponse> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const opened = await open(source, t);
  if (!opened.ok) return { success: false, message: opened.message };
  const parsedPaths = z.array(explorerPathSchema).nonempty().safeParse(paths);
  const parsedDest = explorerPathSchema.safeParse(destDir ?? "");
  const parsedName = explorerNameSchema.safeParse(name);
  if (!parsedPaths.success || !parsedDest.success || !parsedName.success) {
    return { success: false, message: t("invalidInput") };
  }
  const dest = parsedDest.data;
  const file = parsedName.data.toLowerCase().endsWith(".zip")
    ? parsedName.data
    : `${parsedName.data}.zip`;
  try {
    // Never flat: compressing a folder yields an archive containing that
    // folder, which is what every file manager does and what makes unzipping
    // next to the original safe.
    const tree = await collectSelection(
      opened.backend,
      parsedPaths.data,
      false
    );
    const target = await uniqueName(opened.backend, dest, file, false);
    await opened.backend.writeStream(
      joinPath(dest, target),
      zipStream(opened.backend, tree)
    );
    return { success: true, message: t("entriesCompressed") };
  } catch (error) {
    return { success: false, message: explain(error, t) };
  }
}

// What a folder holds, for the properties dialog: a recursive walk, so it is
// requested explicitly rather than computed for every listing row.
type FolderStats = { files: number; folders: number; bytes: number };

export async function folderStats(
  source: unknown,
  path: unknown
): Promise<ActionResponse<FolderStats>> {
  await requireAdmin();
  const t = await getTranslations("actionErrors");
  const opened = await open(source, t);
  if (!opened.ok) return { success: false, message: opened.message };
  const parsedPath = explorerPathSchema.safeParse(path ?? "");
  if (!parsedPath.success) {
    return { success: false, message: t("invalidPath") };
  }
  try {
    const tree = await collectTree(opened.backend, parsedPath.data);
    // Every path segment above a file is a folder; counting the distinct ones
    // is cheaper than walking the tree a second time to list them.
    const folders = new Set<string>(tree.emptyDirs);
    for (const file of tree.files) {
      const parts = file.relPath.split("/").slice(0, -1);
      let cur = "";
      for (const part of parts) {
        cur = cur ? `${cur}/${part}` : part;
        folders.add(`${cur}/`);
      }
    }
    return {
      success: true,
      data: {
        files: tree.files.length,
        folders: folders.size,
        bytes: tree.files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0),
      },
    };
  } catch (error) {
    return { success: false, message: explain(error, t) };
  }
}
