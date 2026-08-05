"use server";

import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/lib/auth-session";
import {
  type ExplorerEntry,
  type ExplorerSource,
  resolveBackend,
} from "@/lib/explorer";
import { PathError } from "@/lib/explorer/path";
import { type Eol, readTextFile, writeTextFile } from "@/lib/explorer/text";
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

type ListResult =
  | { success: true; data: ExplorerEntry[] }
  | { success: false; message: string };

type SimpleResult =
  | { success: true; message?: string }
  | { success: false; message: string };

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
): Promise<SimpleResult> {
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
): Promise<SimpleResult> {
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
): Promise<SimpleResult> {
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
): Promise<SimpleResult> {
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
