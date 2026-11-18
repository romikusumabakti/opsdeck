import * as React from "react";
import type { QuestionContextInput } from "@/lib/assistant/context";
import {
  claimedKind,
  MAX_UPLOADS_PER_QUESTION,
  MiB,
  uploadLimit,
} from "@/lib/assistant/upload-types";
import { deleteUpload, uploadFile } from "@/web/api/assistant";
import type { PickedAttachment } from "./attachment-picker";

/**
 * Unsent question boxes, one draft per chat (or "new"), kept in memory for
 * the tab's session and for one signed-in user at a time. Uploads live here
 * rather than in a component so one started for a chat still lands in that
 * chat's draft after the open chat changes.
 */

export type PendingFile = {
  key: string;
  name: string;
  size: number;
  image: boolean;
  status: "uploading" | "ready" | "failed";
  /** 0..1 while uploading. */
  progress: number;
  /** The upload's id once stored. */
  id?: string;
  error?: string;
};

export type ComposerDraft = {
  text: string;
  attachments: PickedAttachment[];
  files: PendingFile[];
  notice: string | null;
  /** null: not chosen yet (the workspace seeds it). */
  context: QuestionContextInput | null;
};

export const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  attachments: [],
  files: [],
  notice: null,
  context: null,
};

/** A conversation id or NEW_CHAT. */
export type DraftKey = string;
export const NEW_CHAT = "new";

/** Translated words the store cannot get itself (it calls no hooks). */
export type UploadMessages = {
  tooMany: string;
  unsupported: string;
  tooLarge: (limitMb: number) => string;
  failed: (error: unknown) => string;
};

type Listener = () => void;

function createDrafts() {
  let userId: string | null = null;
  let drafts = new Map<DraftKey, ComposerDraft>();
  /** In-flight uploads: file key -> its controller. */
  const controllers = new Map<string, AbortController>();
  const listeners = new Set<Listener>();
  let nextFileKey = 0;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const get = (key: DraftKey): ComposerDraft => drafts.get(key) ?? EMPTY_DRAFT;

  const update = (
    key: DraftKey,
    change: (draft: ComposerDraft) => ComposerDraft
  ) => {
    const prev = get(key);
    const next = change(prev);
    if (next === prev) return;
    drafts = new Map(drafts).set(key, next);
    emit();
  };

  /** Patches a file only while its draft still holds it. */
  const patchFile = (
    key: DraftKey,
    fileKey: string,
    change: Partial<PendingFile>
  ) => {
    if (!get(key).files.some((f) => f.key === fileKey)) return;
    update(key, (d) => ({
      ...d,
      files: d.files.map((f) => (f.key === fileKey ? { ...f, ...change } : f)),
    }));
  };

  const abortFiles = (files: readonly PendingFile[]) => {
    for (const f of files) {
      controllers.get(f.key)?.abort();
      controllers.delete(f.key);
    }
  };

  const start = (
    key: DraftKey,
    fileKey: string,
    file: File,
    messages: UploadMessages
  ) => {
    const controller = new AbortController();
    controllers.set(fileKey, controller);
    uploadFile(file, {
      signal: controller.signal,
      onProgress: (progress) => patchFile(key, fileKey, { progress }),
    })
      .then((uploaded) =>
        patchFile(key, fileKey, {
          status: "ready",
          progress: 1,
          id: uploaded.id,
        })
      )
      .catch((error: unknown) => {
        if ((error as Error)?.name === "AbortError") return;
        patchFile(key, fileKey, {
          status: "failed",
          error: messages.failed(error),
        });
      })
      .finally(() => {
        if (controllers.get(fileKey) === controller) {
          controllers.delete(fileKey);
        }
      });
  };

  return {
    /** Drops every draft (aborting uploads) when another user signs in. */
    forUser(id: string) {
      if (userId === id) return;
      const had = drafts.size > 0;
      for (const draft of drafts.values()) abortFiles(draft.files);
      userId = id;
      drafts = new Map();
      if (had) emit();
    },
    get,
    update,
    /** After a send: the uploads now belong to the question. */
    clear(key: DraftKey) {
      if (!drafts.has(key)) return;
      update(key, () => EMPTY_DRAFT);
    },
    /** The chat is gone: abort its uploads, delete the stored ones. */
    drop(key: DraftKey) {
      const draft = drafts.get(key);
      if (!draft) return;
      abortFiles(draft.files);
      for (const f of draft.files) {
        if (f.id) deleteUpload(f.id).catch(() => {});
      }
      drafts = new Map(drafts);
      drafts.delete(key);
      emit();
    },
    addFiles(key: DraftKey, list: readonly File[], messages: UploadMessages) {
      if (list.length === 0) return;
      const room =
        MAX_UPLOADS_PER_QUESTION -
        get(key).files.filter((f) => f.status !== "failed").length;
      const taken = list.slice(0, Math.max(0, room));
      const added: PendingFile[] = [];
      const uploads: Array<[string, File]> = [];
      for (const file of taken) {
        const fileKey = `f${++nextFileKey}`;
        const kind = claimedKind(file.name);
        const base = {
          key: fileKey,
          name: file.name,
          size: file.size,
          image: kind === "image",
          progress: 0,
        };
        // The server's checks, done here first so a refused file is not
        // sent at all; the server decides by the bytes.
        if (!kind) {
          added.push({
            ...base,
            status: "failed",
            error: messages.unsupported,
          });
        } else if (file.size > uploadLimit(kind)) {
          added.push({
            ...base,
            status: "failed",
            error: messages.tooLarge(Math.round(uploadLimit(kind) / MiB)),
          });
        } else {
          added.push({ ...base, status: "uploading" });
          uploads.push([fileKey, file]);
        }
      }
      update(key, (d) => ({
        ...d,
        notice: taken.length < list.length ? messages.tooMany : null,
        files: [...d.files, ...added],
      }));
      // After the chips exist, so their first progress has one to update.
      for (const [fileKey, file] of uploads)
        start(key, fileKey, file, messages);
    },
    removeFile(key: DraftKey, fileKey: string) {
      const file = get(key).files.find((f) => f.key === fileKey);
      if (!file) return;
      abortFiles([file]);
      // Unsent, so the server removes it; one that cannot be removed now is
      // left to the daily prune.
      if (file.id) deleteUpload(file.id).catch(() => {});
      update(key, (d) => ({
        ...d,
        notice: null,
        files: d.files.filter((f) => f.key !== fileKey),
      }));
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    resetForTests() {
      abortFiles([...drafts.values()].flatMap((d) => d.files));
      for (const c of controllers.values()) c.abort();
      controllers.clear();
      drafts = new Map();
      userId = null;
      nextFileKey = 0;
      listeners.clear();
    },
  };
}

export const composerDrafts = createDrafts();

export function useComposerDraft(
  userId: string,
  key: DraftKey
): [ComposerDraft, (change: (draft: ComposerDraft) => ComposerDraft) => void] {
  composerDrafts.forUser(userId);
  const draft = React.useSyncExternalStore(
    composerDrafts.subscribe,
    () => composerDrafts.get(key),
    () => EMPTY_DRAFT
  );
  const change = React.useCallback(
    (fn: (draft: ComposerDraft) => ComposerDraft) =>
      composerDrafts.update(key, fn),
    [key]
  );
  return [draft, change];
}
