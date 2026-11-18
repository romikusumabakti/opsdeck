import { FileText, ImageIcon, Loader2, X } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { Progress } from "@/components/ui/progress";
import { MAX_UPLOADS_PER_QUESTION } from "@/lib/assistant/upload-types";
import { cn, formatBytes } from "@/lib/utils";
import {
  composerDrafts,
  type DraftKey,
  type PendingFile,
  useComposerDraft,
} from "./composer-drafts";
import { useAssistantErrorText } from "./error-text";

/**
 * Files for the next question, shared by the chat's question box and the
 * Home box: each file uploads as soon as it is added (📎, a drop or a
 * paste) and shows as a chip with its name, size and progress. A file the
 * server (or the size and type check here, which mirrors it) refuses stays
 * as a chip with the reason until removed; it is never sent.
 */

export type { PendingFile };

export function useFileUploads(userId: string, key: DraftKey) {
  const tErrors = useTranslations("assistantErrors");
  const { errorText } = useAssistantErrorText();
  const [draft] = useComposerDraft(userId, key);
  const { files, notice } = draft;

  const add = React.useCallback(
    (list: readonly File[]) =>
      composerDrafts.addFiles(key, list, {
        tooMany: tErrors("tooManyFiles", { max: MAX_UPLOADS_PER_QUESTION }),
        unsupported: tErrors("fileTypeUnsupported"),
        tooLarge: (limitMb) => tErrors("fileTooLarge", { limitMb }),
        failed: errorText,
      }),
    [key, tErrors, errorText]
  );

  const remove = React.useCallback(
    (fileKey: string) => composerDrafts.removeFile(key, fileKey),
    [key]
  );

  /** After a send: the files now belong to the question. */
  const clear = React.useCallback(
    () =>
      composerDrafts.update(key, (d) => ({ ...d, notice: null, files: [] })),
    [key]
  );

  const ready = files.flatMap((f) =>
    f.status === "ready" && f.id ? [f.id] : []
  );
  return {
    files,
    notice,
    add,
    remove,
    clear,
    /** The ids to send with the question. */
    fileIds: ready,
    uploading: files.some((f) => f.status === "uploading"),
    full:
      files.filter((f) => f.status !== "failed").length >=
      MAX_UPLOADS_PER_QUESTION,
  };
}

export type FileUploads = ReturnType<typeof useFileUploads>;

/** The chips of the files for the next question, with any notice. */
export function FileChips({
  uploads,
  readsImages,
}: {
  uploads: FileUploads;
  /** False: the model cannot view images (said under an image's chip). */
  readsImages: boolean;
}) {
  const t = useTranslations("assistant");
  const { files, notice } = uploads;
  if (files.length === 0 && !notice) return null;
  const kept = files.filter((f) => f.status !== "failed");
  const imageUnreadable = !readsImages && kept.some((f) => f.image);
  return (
    <div className="flex flex-col gap-1.5">
      {files.length > 0 && (
        <ul
          className="flex flex-wrap items-start gap-1.5"
          aria-label={t("attachedFiles")}
        >
          {files.map((f) => (
            <li
              key={f.key}
              data-file-chip
              className={cn(
                "flex max-w-72 flex-col gap-1 rounded-md border bg-muted/50 px-2 py-1 text-xs",
                f.status === "failed" && "border-destructive/50"
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {f.status === "uploading" ? (
                  <Loader2
                    className="size-3.5 shrink-0 animate-spin"
                    aria-hidden
                  />
                ) : f.image ? (
                  <ImageIcon className="size-3.5 shrink-0" aria-hidden />
                ) : (
                  <FileText className="size-3.5 shrink-0" aria-hidden />
                )}
                <span className="truncate font-medium">{f.name}</span>
                <span className="shrink-0 text-muted-foreground">
                  {formatBytes(f.size)}
                </span>
                <button
                  type="button"
                  onClick={() => uploads.remove(f.key)}
                  aria-label={t("removeFile", { name: f.name })}
                  className="ms-auto shrink-0 rounded-full outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5"
                >
                  <X />
                </button>
              </span>
              {f.status === "uploading" && (
                <Progress
                  value={Math.round(f.progress * 100)}
                  aria-label={t("uploading", { name: f.name })}
                  className="w-full"
                />
              )}
              {f.status === "failed" && f.error && (
                <span role="alert" className="text-destructive">
                  {f.error}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice && (
        <p role="alert" className="text-xs text-destructive">
          {notice}
        </p>
      )}
      {kept.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          {t("fileWarning")}
        </p>
      )}
      {imageUnreadable && (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          {t("modelNoImages")}
        </p>
      )}
    </div>
  );
}

/**
 * Drop and paste of files onto a question box: `dropProps` go on the box,
 * `onPaste` on its textarea. A paste that also carries text (copied from a
 * document, which some systems put on the clipboard as an image too) pastes
 * the text, not a file.
 */
export function useFileDrop(add: (files: File[]) => void, disabled: boolean) {
  const [dragging, setDragging] = React.useState(false);
  const depth = React.useRef(0);
  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");

  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (disabled || !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (!disabled) add(Array.from(e.dataTransfer.files));
    },
  };

  const onPaste = (e: React.ClipboardEvent) => {
    if (disabled) return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0 || e.clipboardData.getData("text/plain")) return;
    e.preventDefault();
    add(files);
  };

  return { dragging, dropProps, onPaste };
}

/** Shown over a question box while files are dragged onto it. */
export function DropOverlay({ show }: { show: boolean }) {
  const t = useTranslations("assistant");
  if (!show) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] border-2 border-dashed border-primary bg-background/80 text-sm font-medium text-primary"
    >
      {t("dropFiles")}
    </div>
  );
}
