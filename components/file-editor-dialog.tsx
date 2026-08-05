"use client";

import { FileWarning, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { readFileText, saveFileText } from "@/actions/explorer";
import { CodeEditor } from "@/components/code-editor";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
import type { ExplorerEntry, ExplorerSource } from "@/lib/explorer";

type Props = {
  source: ExplorerSource;
  entry: ExplorerEntry;
  onClose: () => void;
  // Listing refresh after a successful write (size and mtime changed).
  onSaved: () => void;
};

// Edit a text file in place. Mounted only while a file is open (the parent
// lazy-loads this module), so the CodeMirror bundle never reaches the browser
// for users who only browse and download.
export default function FileEditorDialog({
  source,
  entry,
  onClose,
  onSaved,
}: Props) {
  const t = useTranslations("explorer");
  const tCommon = useTranslations("common");
  const tUnsaved = useTranslations("unsavedChanges");
  const dialog = useDialog();

  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // `saved` is the last content known to be on the backend; the diff against
  // `value` is what makes the dialog dirty.
  const [saved, setSaved] = React.useState("");
  const [value, setValue] = React.useState("");
  const [eol, setEol] = React.useState<"lf" | "crlf">("lf");
  const [saving, setSaving] = React.useState(false);

  const dirty = !loading && !error && value !== saved;
  useUnsavedChanges(dirty);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    readFileText(source, entry.path).then((result) => {
      if (cancelled) return;
      if (result.success) {
        setSaved(result.content);
        setValue(result.content);
        setEol(result.eol);
      } else {
        setError(result.message);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [source, entry.path]);

  async function save() {
    // Guard against the Mod-s keymap firing while a write is in flight, before
    // the file has loaded, or with nothing to write (which would bump the
    // file's mtime for no reason).
    if (saving || loading || error || !dirty) return;
    setSaving(true);
    const snapshot = value;
    const result = await saveFileText(source, entry.path, snapshot, eol);
    setSaving(false);
    if (!result.success) {
      toast.error(result.message);
      return;
    }
    setSaved(snapshot);
    toast.success(result.message ?? "");
    onSaved();
  }

  // The keymap closes over `save`; a ref keeps the editor's mount-time
  // extension pointing at the current one.
  const saveRef = React.useRef(save);
  React.useEffect(() => {
    saveRef.current = save;
  });

  async function requestClose() {
    if (dirty) {
      const leave = await dialog.confirm({
        title: tUnsaved("title"),
        description: t("discardDescription", { name: entry.name }),
        confirmText: tUnsaved("leave"),
        cancelText: tUnsaved("stay"),
        destructive: true,
      });
      if (!leave) return;
    }
    onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      {/* `open` is pinned: every dismissal (Escape, backdrop, buttons) goes
          through requestClose, which unmounts this component only after the
          discard confirmation. */}
      <DialogContent className="flex h-[85vh] max-h-[85vh] w-full flex-col gap-4 sm:max-w-4xl">
        <DialogHeader className="shrink-0">
          <DialogTitle className="truncate">{entry.name}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">
            {entry.path}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <div className="flex flex-1 min-h-0 items-center justify-center">
            <EmptyState
              icon={FileWarning}
              title={t("editUnavailable")}
              description={error}
            />
          </div>
        ) : loading ? (
          <div className="flex flex-1 min-h-0 flex-col gap-2 rounded-md border bg-card p-3">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton
                key={`sk-${i}`}
                className="h-4"
                style={{ width: `${40 + ((i * 17) % 55)}%` }}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-1 min-h-0 overflow-hidden rounded-md border bg-card">
            <CodeEditor
              className="flex-1"
              value={value}
              filename={entry.name}
              onChange={setValue}
              onSave={() => saveRef.current()}
              readOnly={saving}
            />
          </div>
        )}

        <DialogFooter className="shrink-0 sm:items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {dirty ? t("unsavedEdits") : t("saveHint")}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={requestClose}
              disabled={saving}
            >
              {tCommon("cancel")}
            </Button>
            <Button
              type="button"
              onClick={save}
              disabled={saving || loading || !!error || !dirty}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              {tCommon("save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
