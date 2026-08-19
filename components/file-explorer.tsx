"use client";

import { formatDistanceToNow } from "date-fns";
import {
  ChevronRight,
  Download,
  File as FileIcon,
  FileUp,
  Folder,
  FolderPlus,
  FolderUp,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
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
  moveEntry,
  renameEntry,
} from "@/actions/explorer";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
import {
  type PendingUpload,
  pendingFromDrop,
  pendingFromInput,
  uploadAll,
} from "@/lib/explorer-upload";
import { cn, formatBytes } from "@/lib/utils";

// The editor drags in CodeMirror and its lazily-loaded language modes. Split it
// out so browsing and downloading don't pay for a bundle most visits never use.
const FileEditorDialog = dynamic(
  () => import("@/components/file-editor-dialog")
);

// Custom drag type marking a drag that started inside the explorer. Only the
// type list (not the value) is readable during dragover, which is where the
// decision "is this a move or an upload?" has to be made, so the distinction
// has to live in the MIME type itself.
const MOVE_MIME = "application/x-opsdeck-explorer-entry";

type RowAction = {
  key: string;
  icon: React.ReactNode;
  label: string;
  run: () => void;
};

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

// True when the drag carries OS files rather than an entry being moved inside
// the explorer.
function isFileDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes("Files");
}

function isMoveDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(MOVE_MIME);
}

// Whether a dragged entry can land in `dirPath`. Rejects a folder dropped on
// itself or anywhere inside its own subtree; the server enforces the same rule.
function canMove(from: string | null, dirPath: string): boolean {
  if (!from) return false;
  if (from === dirPath) return false;
  if (from.endsWith("/") && dirPath.startsWith(from)) return false;
  return true;
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
  // Path of the row whose ⋯ menu is open, or null — only one can be open at a
  // time. Controlled so that opening a context menu anywhere closes it: at most
  // one menu is ever on screen, whatever route the pointer took to get there.
  const [rowMenuOpen, setRowMenuOpen] = React.useState<string | null>(null);
  // Path of the entry being dragged inside the explorer, and the directory
  // currently highlighted as its drop target ("" = the current folder).
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<string | null>(null);
  // Whether an OS file drag is hovering the panel, for the drop overlay.
  const [fileDrag, setFileDrag] = React.useState(false);
  // dragenter/dragleave fire for every nested element, so a plain boolean would
  // flicker as the pointer crosses cell boundaries. Count enters instead.
  const dragDepth = React.useRef(0);

  const fileInput = React.useRef<HTMLInputElement>(null);
  const folderInput = React.useRef<HTMLInputElement>(null);

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

  // A GET the browser can follow straight into a download: the route streams the
  // folder as a ZIP under the caller's own session cookie.
  const archiveUrl = React.useCallback(
    (dirPath: string) =>
      `/api/explorer/archive?source=${encodeURIComponent(
        JSON.stringify(source)
      )}&path=${encodeURIComponent(dirPath)}`,
    [source]
  );

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
      // Deleting a folder takes its contents with it, which the copy has to say
      // out loud — the listing doesn't show what is nested inside.
      description:
        entry.type === "dir"
          ? t("deleteFolderDescription", { name: entry.name })
          : t("deleteDescription", { name: entry.name }),
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

  // Shared by the toolbar pickers and every drop that carries OS files.
  const upload = React.useCallback(
    async (items: PendingUpload[], destDir: string) => {
      const single = items.length === 1 ? items[0] : null;
      if (items.length === 0) return;
      setBusy(true);
      const toastId = toast.loading(
        t("uploading", { done: 0, total: items.length })
      );
      try {
        const { uploaded, failed } = await uploadAll(
          source,
          destDir,
          items,
          (done, total) => {
            toast.loading(t("uploading", { done, total }), { id: toastId });
          }
        );
        if (failed > 0) {
          toast.error(t("uploadPartial", { failed, total: items.length }), {
            id: toastId,
          });
        } else if (single) {
          toast.success(t("uploaded", { name: single.file.name }), {
            id: toastId,
          });
        } else {
          toast.success(t("uploadedCount", { count: uploaded }), {
            id: toastId,
          });
        }
      } finally {
        setBusy(false);
        refresh();
      }
    },
    [source, t, refresh]
  );

  function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const items = pendingFromInput(event.target.files);
    event.target.value = ""; // allow re-selecting the same file/folder
    upload(items, path);
  }

  async function onMove(from: string, destDir: string) {
    setBusy(true);
    const result = await moveEntry(source, from, destDir);
    setBusy(false);
    if (!result.success) {
      toast.error(result.message);
      return;
    }
    if (result.message) toast.success(result.message);
    refresh();
  }

  // Clear every transient drag flag. Called from each terminal drag event, since
  // whichever handler wins the drop is the only one that runs.
  const endDrag = React.useCallback(() => {
    dragDepth.current = 0;
    setFileDrag(false);
    setDropTarget(null);
    setDragging(null);
  }, []);

  // Drop handlers for anything that accepts a directory: folder rows and
  // breadcrumbs. Files land in `dirPath`; a dragged entry moves into it.
  function dirDropProps(dirPath: string) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (isMoveDrag(e)) {
          if (!canMove(dragging, dirPath)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        } else if (isFileDrag(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        } else {
          return;
        }
        e.stopPropagation();
        setDropTarget(dirPath);
      },
      onDragLeave: (e: React.DragEvent) => {
        // Ignore the leave events fired while crossing between child cells.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropTarget((cur) => (cur === dirPath ? null : cur));
      },
      onDrop: (e: React.DragEvent) => {
        if (!(isMoveDrag(e) || isFileDrag(e))) return;
        e.preventDefault();
        e.stopPropagation();
        const from = e.dataTransfer.getData(MOVE_MIME);
        const dataTransfer = e.dataTransfer;
        endDrag();
        if (from) {
          if (canMove(from, dirPath)) onMove(from, dirPath);
          return;
        }
        pendingFromDrop(dataTransfer).then((items) => upload(items, dirPath));
      },
    };
  }

  // Panel-level drop: uploads into the folder currently being browsed. Move
  // drags are ignored here — the entry already lives in this folder.
  const panelDropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setFileDrag(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      dragDepth.current--;
      if (dragDepth.current <= 0) {
        dragDepth.current = 0;
        setFileDrag(false);
      }
    },
    onDrop: (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      const dataTransfer = e.dataTransfer;
      endDrag();
      pendingFromDrop(dataTransfer).then((items) => upload(items, path));
    },
  };

  function rowDragProps(entry: ExplorerEntry) {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData(MOVE_MIME, entry.path);
        // A plain-text flavour so dragging out to another app degrades to the
        // entry name instead of an empty payload.
        e.dataTransfer.setData("text/plain", entry.name);
        e.dataTransfer.effectAllowed = "move";
        setDragging(entry.path);
      },
      onDragEnd: endDrag,
      ...(entry.type === "dir" ? dirDropProps(entry.path) : {}),
    };
  }

  // The ⋯ button and the right-click menu offer exactly the same actions, so
  // the list is declared once and rendered through whichever menu is in play.
  // Delete is appended separately by each menu, behind a separator.
  function rowActions(entry: ExplorerEntry): RowAction[] {
    const actions: RowAction[] =
      entry.type === "file"
        ? [
            {
              key: "edit",
              icon: <SquarePen className="size-4" />,
              label: t("edit"),
              run: () => setEditing(entry),
            },
            {
              key: "download",
              icon: <Download className="size-4" />,
              label: t("download"),
              run: () => onOpen(entry),
            },
          ]
        : [
            {
              key: "open",
              icon: <Folder className="size-4" />,
              label: t("open"),
              run: () => onOpen(entry),
            },
            {
              key: "zip",
              icon: <Download className="size-4" />,
              label: t("downloadZip"),
              run: () => window.open(archiveUrl(entry.path), "_blank"),
            },
          ];
    actions.push({
      key: "rename",
      icon: <Pencil className="size-4" />,
      label: t("rename"),
      run: () => onRename(entry),
    });
    return actions;
  }

  const trail = crumbs(path);

  const header = (
    <TableHeader className="sticky top-0 z-10 [&_th]:bg-card [&_th]:border-b">
      <TableRow>
        <TableHead>{t("name")}</TableHead>
        <TableHead className="w-32 text-right">{t("size")}</TableHead>
        <TableHead className="w-48">{t("modified")}</TableHead>
        <TableHead className="w-12" />
      </TableRow>
    </TableHeader>
  );

  // Wraps the browsing area: right-click anywhere that isn't a row acts on the
  // folder being browsed, and OS files dropped anywhere in it upload here.
  // A plain function, not a component — declaring a component inside the render
  // would give it a fresh identity every render and remount the whole table.
  function panel(children: React.ReactNode) {
    return (
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              className={cn(
                "relative flex flex-1 min-h-0 flex-col overflow-hidden rounded-md border bg-card transition-colors",
                fileDrag && "border-primary/60 bg-primary/5"
              )}
              {...panelDropProps}
            />
          }
        >
          {children}
          {fileDrag ? (
            // A hint, not a curtain: it must not obscure the rows, because a
            // folder row is itself a drop target and the highlight showing
            // which one is under the pointer has to stay readable. Pointer
            // events are off so the drop still reaches that row.
            <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center">
              <div className="rounded-md border border-primary border-dashed bg-background/95 px-3 py-1.5 text-sm font-medium shadow-sm">
                {t("dropToUpload")}
              </div>
            </div>
          ) : null}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={onNewFolder}>
            <FolderPlus className="size-4" />
            {t("newFolder")}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => fileInput.current?.click()}>
            <FileUp className="size-4" />
            {t("uploadFiles")}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => folderInput.current?.click()}>
            <FolderUp className="size-4" />
            {t("uploadFolder")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => window.open(archiveUrl(path), "_blank")}
          >
            <Download className="size-4" />
            {t("downloadFolderZip")}
          </ContextMenuItem>
          <ContextMenuItem onClick={refresh}>
            <RefreshCw className="size-4" />
            {t("refresh")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-4">
      {/* Toolbar: breadcrumb + actions. Stays pinned while the list scrolls. */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-2">
        <nav className="flex items-center gap-1 text-sm text-muted-foreground">
          <button
            type="button"
            className={cn(
              "rounded px-1 py-0.5 hover:text-foreground",
              dropTarget === "" &&
                "bg-primary/10 text-foreground ring-1 ring-primary/40"
            )}
            onClick={() => setPath("")}
            {...dirDropProps("")}
          >
            {rootLabel}
          </button>
          {trail.map((c) => (
            <React.Fragment key={c.path}>
              <ChevronRight className="size-3.5 shrink-0" />
              <button
                type="button"
                className={cn(
                  "rounded px-1 py-0.5 hover:text-foreground",
                  dropTarget === c.path &&
                    "bg-primary/10 text-foreground ring-1 ring-primary/40"
                )}
                onClick={() => setPath(c.path)}
                {...dirDropProps(c.path)}
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
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type="button" size="sm" disabled={busy}>
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Upload className="size-4" />
                  )}
                  {t("upload")}
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => fileInput.current?.click()}>
                <FileUp className="size-4" />
                {t("uploadFiles")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => folderInput.current?.click()}>
                <FolderUp className="size-4" />
                {t("uploadFolder")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={onPick}
          />
          <input
            ref={folderInput}
            type="file"
            className="hidden"
            onChange={onPick}
            // Directory picking still has no standard attribute; every engine
            // that supports it reads the webkit-prefixed one, which React has
            // no typing for.
            {...({
              webkitdirectory: "",
            } as React.InputHTMLAttributes<HTMLInputElement>)}
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
            {header}
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
        panel(
          <div className="flex flex-1 min-h-0 items-center justify-center">
            <EmptyState
              icon={Folder}
              title={t("emptyTitle")}
              description={t("emptyDescription")}
            />
          </div>
        )
      ) : (
        // Body scrolls inside this bounded bg-card panel; the header row pins
        // via sticky (single-<table> layout, same approach as DataTable).
        panel(
          <Table containerClassName="flex-1 min-h-0">
            {header}
            <TableBody>
              {entries.map((entry) => (
                <ContextMenu
                  key={entry.path}
                  onOpenChange={(open) => {
                    if (open) setRowMenuOpen(null);
                  }}
                >
                  <ContextMenuTrigger
                    render={
                      <TableRow
                        onClick={onRowClick(entry)}
                        onKeyDown={onRowKeyDown(entry)}
                        // No role override: a <tr> must stay a `row` for the
                        // table's semantics to survive. Focusability +
                        // Enter/Space is enough to make the row reachable
                        // without a pointer.
                        tabIndex={0}
                        className={cn(
                          "cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                          dragging === entry.path && "opacity-40",
                          dropTarget === entry.path &&
                            "bg-primary/10 ring-1 ring-primary/40 ring-inset"
                        )}
                        {...rowDragProps(entry)}
                      />
                    }
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
                    <TableCell
                      // The ⋯ control owns its own menu, so a right-click here
                      // must not also open the row's context menu. preventDefault
                      // as well as stopPropagation: without it the browser's own
                      // menu would take over this one cell, which reads as broken
                      // next to every other cell in the row.
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                    >
                      <DropdownMenu
                        open={rowMenuOpen === entry.path}
                        onOpenChange={(open) =>
                          setRowMenuOpen(open ? entry.path : null)
                        }
                      >
                        <DropdownMenuTrigger
                          render={
                            <Button variant="ghost" size="icon-sm">
                              <MoreHorizontal className="size-4" />
                            </Button>
                          }
                        />
                        <DropdownMenuContent align="end">
                          {rowActions(entry).map((item) => (
                            <DropdownMenuItem key={item.key} onClick={item.run}>
                              {item.icon}
                              {item.label}
                            </DropdownMenuItem>
                          ))}
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
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    {rowActions(entry).map((item) => (
                      <ContextMenuItem key={item.key} onClick={item.run}>
                        {item.icon}
                        {item.label}
                      </ContextMenuItem>
                    ))}
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      variant="destructive"
                      onClick={() => onDelete(entry)}
                    >
                      <Trash2 className="size-4" />
                      {tCommon("delete")}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </TableBody>
          </Table>
        )
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
