"use client";

import { ChevronRight, Folder } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { listEntries } from "@/actions/explorer";
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
import type { ExplorerEntry, ExplorerSource } from "@/lib/explorer";
import { cn } from "@/lib/utils";

type Props = {
  source: ExplorerSource;
  title: string;
  confirmText: string;
  // Label for the root crumb, same string the explorer shows.
  rootLabel: string;
  // Where browsing starts — normally the folder the user is looking at.
  initialPath: string;
  // Destinations the operation can't use: the entries being moved or copied,
  // and anything nested inside them.
  blocked?: string[];
  onClose: () => void;
  onPick: (dir: string) => void;
};

// Split a path into breadcrumb segments, same convention as the explorer: dir
// paths carry a trailing slash, "" is the root.
function crumbs(path: string): { name: string; path: string }[] {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return [];
  let cur = "";
  return trimmed.split("/").map((part) => {
    cur = cur ? `${cur}/${part}` : part;
    return { name: part, path: `${cur}/` };
  });
}

// Destination picker for "Move to…" / "Copy to…". Folders only: the operation
// lands *in* a directory, so files would be noise. Kept deliberately plain —
// browse down, confirm the folder you are standing in.
export default function FolderPickerDialog({
  source,
  title,
  confirmText,
  rootLabel,
  initialPath,
  blocked = [],
  onClose,
  onPick,
}: Props) {
  const t = useTranslations("explorer");
  const tCommon = useTranslations("common");

  const [path, setPath] = React.useState(initialPath);
  const [dirs, setDirs] = React.useState<ExplorerEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listEntries(source, path).then((result) => {
      if (cancelled) return;
      if (result.success) {
        setDirs(result.data.filter((entry) => entry.type === "dir"));
      } else {
        setError(result.message);
        setDirs([]);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [source, path]);

  // A folder being moved can't receive itself, and neither can anything under
  // it — the same rule the drag-and-drop path enforces.
  const isBlocked = (dir: string) =>
    blocked.some((p) => p === dir || (p.endsWith("/") && dir.startsWith(p)));

  const trail = crumbs(path);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex h-[70vh] max-h-[70vh] w-full flex-col gap-4 sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">
            {path ? `/${path.replace(/\/+$/, "")}` : rootLabel}
          </DialogDescription>
        </DialogHeader>

        <nav className="shrink-0 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <button
            type="button"
            className="rounded px-1 py-0.5 hover:text-foreground"
            onClick={() => setPath("")}
          >
            {rootLabel}
          </button>
          {trail.map((crumb) => (
            <React.Fragment key={crumb.path}>
              <ChevronRight className="size-3.5 shrink-0" />
              <button
                type="button"
                className="rounded px-1 py-0.5 hover:text-foreground"
                onClick={() => setPath(crumb.path)}
              >
                {crumb.name}
              </button>
            </React.Fragment>
          ))}
        </nav>

        <div className="flex flex-1 min-h-0 flex-col overflow-y-auto rounded-md border bg-card">
          {error ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState
                icon={Folder}
                title={t("loadFailed")}
                description={error}
              />
            </div>
          ) : loading ? (
            <div className="flex flex-col gap-2 p-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={`sk-${i}`} className="h-6 w-full" />
              ))}
            </div>
          ) : dirs.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">
              <EmptyState icon={Folder} title={t("noSubfolders")} />
            </div>
          ) : (
            <ul>
              {dirs.map((dir) => {
                const disabled = isBlocked(dir.path);
                return (
                  <li key={dir.path}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => setPath(dir.path)}
                      className={cn(
                        "flex w-full items-center gap-2 border-b px-3 py-2 text-start text-sm last:border-b-0",
                        disabled
                          ? "cursor-not-allowed opacity-40"
                          : "hover:bg-muted/50"
                      )}
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{dir.name}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button
            type="button"
            disabled={isBlocked(path)}
            onClick={() => onPick(path)}
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
