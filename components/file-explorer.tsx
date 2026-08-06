"use client";

import { formatDistanceToNow } from "date-fns";
import {
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  SquarePen,
  Trash2,
  Upload,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import {
  createFolder,
  deleteEntry,
  getDownloadTarget,
  listEntries,
  renameEntry,
} from "@/actions/explorer";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import type { ExplorerEntry, ExplorerSource } from "@/lib/explorer";
import { formatBytes } from "@/lib/utils";

// The editor drags in CodeMirror and its lazily-loaded language modes. Split it
// out so browsing and downloading don't pay for a bundle most visits never use.
const FileEditorDialog = dynamic(
  () => import("@/components/file-editor-dialog")
);

type Props = {
  source: ExplorerSource;
  // Label for the root crumb (e.g. the bucket name or "/").
  rootLabel: string;
};

// Split a path into breadcrumb segments with their cumulative paths. Trailing
// slash on dirs is dropped for display; each crumb navigates to that dir.
function crumbs(path: string): { name: string; path: string }[] {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return [];
  const parts = trimmed.split("/");
  const acc: { name: string; path: string }[] = [];
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    acc.push({ name: part, path: `${cur}/` });
  }
  return acc;
}

export function FileExplorer({ source, rootLabel }: Props) {
  const t = useTranslations("explorer");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const dialog = useDialog();

  // "" = root. Dir paths carry a trailing slash (backend convention).
  const [path, setPath] = React.useState("");
  const [entries, setEntries] = React.useState<ExplorerEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // The file currently open in the editor; null when the editor is closed.
  const [editing, setEditing] = React.useState<ExplorerEntry | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await listEntries(source, path);
    if (result.success) {
      setEntries(result.data);
    } else {
      setError(result.message);
      setEntries([]);
    }
    setLoading(false);
  }, [source, path]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function onOpen(entry: ExplorerEntry) {
    if (entry.type === "dir") {
      setPath(entry.path);
      return;
    }
    // File: resolve a download target and hand it to the browser. Presigned
    // URLs (S3) open directly; proxy targets (SFTP) go through the route.
    const result = await getDownloadTarget(source, entry.path);
    if (!result.success) {
      toast.error(result.message);
      return;
    }
    const url =
      result.target.kind === "presigned"
        ? result.target.url
        : `/api/explorer/download?source=${encodeURIComponent(
            JSON.stringify(source)
          )}&path=${encodeURIComponent(entry.path)}`;
    window.open(url, "_blank");
  }

  // The whole row is the click target. Clicks that land on a nested control
  // (the row-actions menu and anything it renders) belong to that control, so
  // they never reach onOpen.
  function onRowClick(entry: ExplorerEntry) {
    return (e: React.MouseEvent) => {
      if (
        (e.target as HTMLElement).closest(
          'button, a, input, label, [role="menu"], [role="menuitem"]'
        )
      ) {
        return;
      }
      onOpen(entry);
    };
  }

  // Keyboard equivalent. Only fires when the row itself holds focus — Enter or
  // Space typed on a nested button belongs to that button.
  function onRowKeyDown(entry: ExplorerEntry) {
    return (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      onOpen(entry);
    };
  }

  async function onNewFolder() {
    const name = await dialog.prompt({
      title: t("newFolder"),
      description: t("newFolderDescription"),
      placeholder: t("folderNamePlaceholder"),
      confirmText: tCommon("create"),
      cancelText: tCommon("cancel"),
    });
    if (!name) return;
    setBusy(true);
    const result = await createFolder(source, path, name);
    setBusy(false);
    if (!result.success) {
      toast.error(result.message);
      return;
    }
    toast.success(result.message ?? "");
    refresh();
  }

  async function onRename(entry: ExplorerEntry) {
    const name = await dialog.prompt({
      title: t("rename"),
      defaultValue: entry.name,
      placeholder: t("newNamePlaceholder"),
      confirmText: tCommon("save"),
      cancelText: tCommon("cancel"),
    });
    if (!name || name === entry.name) return;
    setBusy(true);
    const result = await renameEntry(source, entry.path, name);
    setBusy(false);
    if (!result.success) {
      toast.error(result.message);
      return;
    }
    toast.success(result.message ?? "");
    refresh();
  }

  async function onDelete(entry: ExplorerEntry) {
    const ok = await dialog.confirm({
      title: t("deleteTitle"),
      description: t("deleteDescription", { name: entry.name }),
      confirmText: tCommon("delete"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    const result = await deleteEntry(source, entry.path);
    setBusy(false);
    if (!result.success) {
      toast.error(result.message);
      return;
    }
    toast.success(result.message ?? "");
    refresh();
  }

  async function onUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-selecting the same file
    if (!file) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.set("source", JSON.stringify(source));
      body.set("path", path);
      body.set("file", file);
      const res = await fetch("/api/explorer/upload", {
        method: "POST",
        body,
      });
      if (!res.ok) {
        toast.error(t("uploadFailed"));
        return;
      }
      toast.success(t("uploaded", { name: file.name }));
      refresh();
    } finally {
      setBusy(false);
    }
  }

  const trail = crumbs(path);

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-4">
      {/* Toolbar: breadcrumb + actions. Stays pinned while the list scrolls. */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-2">
        <nav className="flex items-center gap-1 text-sm text-muted-foreground">
          <button
            type="button"
            className="hover:text-foreground"
            onClick={() => setPath("")}
          >
            {rootLabel}
          </button>
          {trail.map((c) => (
            <React.Fragment key={c.path}>
              <ChevronRight className="size-3.5 shrink-0" />
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => setPath(c.path)}
              >
                {c.name}
              </button>
            </React.Fragment>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onNewFolder}
            disabled={busy}
          >
            <FolderPlus className="size-4" />
            {t("newFolder")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {t("upload")}
          </Button>
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            onChange={onUpload}
          />
        </div>
      </div>

      {error ? (
        <div className="flex flex-1 min-h-0 items-center justify-center">
          <EmptyState
            icon={Folder}
            title={t("loadFailed")}
            description={error}
          />
        </div>
      ) : loading ? (
        // Skeleton mirrors the real table below (same panel, header, columns)
        // so there's no layout shift when entries arrive.
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-md border bg-card">
          <Table containerClassName="flex-1 min-h-0">
            <TableHeader className="sticky top-0 z-10 [&_th]:bg-card [&_th]:border-b">
              <TableRow>
                <TableHead>{t("name")}</TableHead>
                <TableHead className="w-32 text-right">{t("size")}</TableHead>
                <TableHead className="w-48">{t("modified")}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from({ length: 8 }, (_, i) => (
                <TableRow key={`sk-${i}`}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Skeleton className="size-4 shrink-0 rounded-sm" />
                      <Skeleton className="h-4 w-40" />
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Skeleton className="ml-auto h-4 w-12" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="h-4 w-24" />
                  </TableCell>
                  <TableCell>
                    <Skeleton className="size-8 rounded-md" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-1 min-h-0 items-center justify-center">
          <EmptyState
            icon={Folder}
            title={t("emptyTitle")}
            description={t("emptyDescription")}
          />
        </div>
      ) : (
        // Body scrolls inside this bounded bg-card panel; the header row pins
        // via sticky (single-<table> layout, same approach as DataTable).
        <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-md border bg-card">
          <Table containerClassName="flex-1 min-h-0">
            <TableHeader className="sticky top-0 z-10 [&_th]:bg-card [&_th]:border-b">
              <TableRow>
                <TableHead>{t("name")}</TableHead>
                <TableHead className="w-32 text-right">{t("size")}</TableHead>
                <TableHead className="w-48">{t("modified")}</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow
                  key={entry.path}
                  onClick={onRowClick(entry)}
                  onKeyDown={onRowKeyDown(entry)}
                  // No role override: a <tr> must stay a `row` for the table's
                  // semantics to survive. Focusability + Enter/Space is enough
                  // to make the row reachable without a pointer.
                  tabIndex={0}
                  className="cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <TableCell>
                    <div className="flex items-center gap-2 text-left">
                      {entry.type === "dir" ? (
                        <Folder className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate">{entry.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {entry.type === "file" && entry.sizeBytes != null
                      ? formatBytes(entry.sizeBytes)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {entry.modifiedAt
                      ? formatDistanceToNow(new Date(entry.modifiedAt), {
                          addSuffix: true,
                          locale: getDateFnsLocale(locale),
                        })
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="icon-sm">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end">
                        {entry.type === "file" ? (
                          <>
                            <DropdownMenuItem onClick={() => setEditing(entry)}>
                              <SquarePen className="size-4" />
                              {t("edit")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => onOpen(entry)}>
                              <Download className="size-4" />
                              {t("download")}
                            </DropdownMenuItem>
                          </>
                        ) : null}
                        <DropdownMenuItem onClick={() => onRename(entry)}>
                          <Pencil className="size-4" />
                          {t("rename")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => onDelete(entry)}
                        >
                          <Trash2 className="size-4" />
                          {tCommon("delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {editing ? (
        <FileEditorDialog
          source={source}
          entry={editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}
