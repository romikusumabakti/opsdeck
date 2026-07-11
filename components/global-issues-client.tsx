"use client";

import { formatDistanceToNow } from "date-fns";
import {
  Bookmark,
  ChevronDown,
  CircleDot,
  LayoutGrid,
  List,
  Search,
  Trash2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import type { GlobalIssue } from "@/actions/issues";
import { setIssueStatus, updateIssue } from "@/actions/issues";
import { createSavedView, deleteSavedView } from "@/actions/saved-views";
import {
  type AssignableUser,
  AssigneeSelect,
  IssueBoard,
  type Status,
  StatusSelect,
} from "@/components/issues-board";
import { LabelChips } from "@/components/label-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Link, useRouter } from "@/i18n/navigation";
import { getDateFnsLocale } from "@/lib/date-fns-locale";

const ALL = "all";

export function GlobalIssuesClient({
  initialIssues,
  currentUserId,
  users,
  allLabels,
  initialFilters,
  savedViews,
}: {
  initialIssues: GlobalIssue[];
  currentUserId: string;
  users: AssignableUser[];
  allLabels: { id: string; name: string; color: string }[];
  initialFilters: Record<string, string>;
  savedViews: { id: string; name: string; params: Record<string, string> }[];
}) {
  const t = useTranslations("issues");
  const locale = useLocale();
  const dateFnsLocale = getDateFnsLocale(locale);
  const router = useRouter();

  const [issues, setIssues] = React.useState(initialIssues);
  React.useEffect(() => setIssues(initialIssues), [initialIssues]);

  const usersById = React.useMemo(
    () => Object.fromEntries(users.map((u) => [u.id, u.name])),
    [users]
  );

  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<string>(
    initialFilters.status ?? ALL
  );
  const [projectId, setProjectId] = React.useState<string>(
    initialFilters.project ?? ALL
  );
  const [labelId, setLabelId] = React.useState<string>(
    initialFilters.label ?? ALL
  );
  const [mineOnly, setMineOnly] = React.useState(initialFilters.mine === "1");
  const [view, setView] = React.useState<"table" | "board">(
    initialFilters.view === "board" ? "board" : "table"
  );

  // The filter dimensions as a flat map (defaults omitted) — this is both the
  // URL query and what a saved view stores.
  const currentParams = React.useCallback((): Record<string, string> => {
    const p: Record<string, string> = {};
    if (status !== ALL) p.status = status;
    if (projectId !== ALL) p.project = projectId;
    if (labelId !== ALL) p.label = labelId;
    if (mineOnly) p.mine = "1";
    if (view === "board") p.view = "board";
    return p;
  }, [status, projectId, labelId, mineOnly, view]);

  // Reflect filters in the URL so a view is shareable/bookmarkable. `query` is
  // transient search — deliberately not synced.
  React.useEffect(() => {
    const qs = new URLSearchParams(currentParams()).toString();
    router.replace(qs ? `/issues?${qs}` : "/issues", { scroll: false });
  }, [currentParams, router]);

  function applyParams(p: Record<string, string>) {
    setStatus(p.status ?? ALL);
    setProjectId(p.project ?? ALL);
    setLabelId(p.label ?? ALL);
    setMineOnly(p.mine === "1");
    setView(p.view === "board" ? "board" : "table");
  }

  const [saveOpen, setSaveOpen] = React.useState(false);
  const [viewName, setViewName] = React.useState("");

  async function onSaveView() {
    const name = viewName.trim();
    if (!name) return;
    const result = await createSavedView(name, currentParams());
    if (result.success) {
      toast.success(t("viewSaved"));
      setViewName("");
      setSaveOpen(false);
      router.refresh();
    }
  }

  async function onDeleteView(id: string) {
    await deleteSavedView(id);
    router.refresh();
  }

  // Distinct projects present, for the project filter.
  const projectOptions = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues) map.set(i.project.id, i.project.name);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [issues]);

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return issues.filter((i) => {
      if (status !== ALL && i.status !== status) return false;
      if (projectId !== ALL && i.project.id !== projectId) return false;
      if (labelId !== ALL && !i.labels.some((l) => l.id === labelId))
        return false;
      if (mineOnly && i.assignee?.id !== currentUserId) return false;
      if (
        q &&
        !i.title.toLowerCase().includes(q) &&
        !`${i.project.key}-${i.number}`.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [issues, query, status, projectId, labelId, mineOnly, currentUserId]);

  async function onStatusChange(id: string, next: Status) {
    setIssues((prev) =>
      prev.map((i) => (i.id === id ? { ...i, status: next } : i))
    );
    const result = await setIssueStatus(id, next);
    if (!result.success) {
      toast.error(t("updateFailed"));
    } else {
      toast.success(t("statusUpdated"));
    }
    router.refresh();
  }

  async function onAssigneeChange(id: string, assigneeId: string | null) {
    setIssues((prev) =>
      prev.map((i) =>
        i.id === id
          ? {
              ...i,
              assignee: assigneeId
                ? { id: assigneeId, name: usersById[assigneeId] ?? "" }
                : null,
            }
          : i
      )
    );
    const result = await updateIssue(id, { assigneeId });
    if (!result.success) toast.error(t("updateFailed"));
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" className="gap-1.5">
                <Bookmark className="size-4" />
                {t("views")}
                <ChevronDown className="size-3.5 opacity-60" />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="w-56">
            {savedViews.length === 0 ? (
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                {t("noSavedViews")}
              </DropdownMenuLabel>
            ) : (
              savedViews.map((v) => (
                <DropdownMenuItem
                  key={v.id}
                  onClick={() => applyParams(v.params)}
                  className="justify-between gap-2"
                >
                  <span className="truncate">{v.name}</span>
                  <button
                    type="button"
                    aria-label={t("deleteView")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteView(v.id);
                    }}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setSaveOpen(true)}>
              <Bookmark className="size-4" />
              {t("saveView")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="ps-9"
            aria-label={t("searchPlaceholder")}
          />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v ?? ALL)}>
          <SelectTrigger className="w-40" aria-label={t("filterStatus")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allStatuses")}</SelectItem>
            {(["open", "in_progress", "resolved", "closed"] as const).map(
              (s) => (
                <SelectItem key={s} value={s}>
                  {t(`status.${s}`)}
                </SelectItem>
              )
            )}
          </SelectContent>
        </Select>
        <Select value={projectId} onValueChange={(v) => setProjectId(v ?? ALL)}>
          <SelectTrigger className="w-44" aria-label={t("project")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allProjects")}</SelectItem>
            {projectOptions.map(([id, name]) => (
              <SelectItem key={id} value={id}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={labelId} onValueChange={(v) => setLabelId(v ?? ALL)}>
          <SelectTrigger className="w-40" aria-label={t("filterLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allLabels")}</SelectItem>
            {allLabels.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                <span className="flex items-center gap-2">
                  <span
                    className="size-2.5 rounded-full"
                    style={{ backgroundColor: l.color }}
                  />
                  {l.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={mineOnly ? "secondary" : "outline"}
          onClick={() => setMineOnly((v) => !v)}
        >
          {t("assignedToMe")}
        </Button>
        <div className="flex rounded-md border p-0.5">
          <Button
            type="button"
            variant={view === "table" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2"
            onClick={() => setView("table")}
            aria-label={t("viewTable")}
          >
            <List className="size-4" />
          </Button>
          <Button
            type="button"
            variant={view === "board" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2"
            onClick={() => setView("board")}
            aria-label={t("viewBoard")}
          >
            <LayoutGrid className="size-4" />
          </Button>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-12 text-center">
          <CircleDot className="size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </div>
      ) : view === "board" ? (
        <IssueBoard
          showProject
          issues={visible.map((i) => ({
            id: i.id,
            number: i.number,
            title: i.title,
            status: i.status as Status,
            keyPrefix: i.project.key,
            projectName: i.project.name,
            envName: i.environment?.name ?? null,
            assigneeName: i.assignee?.name ?? null,
            labels: i.labels,
          }))}
          onStatusChange={onStatusChange}
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">{t("columnKey")}</TableHead>
                <TableHead>{t("columnTitle")}</TableHead>
                <TableHead className="w-44">{t("columnProject")}</TableHead>
                <TableHead className="w-40">{t("columnStatus")}</TableHead>
                <TableHead className="w-32">{t("columnAssignee")}</TableHead>
                <TableHead className="w-32">{t("columnCreated")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((issue) => (
                <TableRow key={issue.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    <Link
                      href={`/project/${issue.project.key}/${issue.number}`}
                      className="hover:text-foreground hover:underline"
                    >
                      {issue.project.key}-{issue.number}
                    </Link>
                  </TableCell>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-2">
                      <Link
                        href={`/project/${issue.project.key}/${issue.number}`}
                        className="hover:underline"
                      >
                        {issue.title}
                      </Link>
                      <LabelChips labels={issue.labels} />
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground truncate">
                    <Link
                      href={`/project/${issue.project.key}`}
                      className="hover:underline"
                    >
                      {issue.project.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusSelect
                      value={issue.status as Status}
                      onChange={(s) => onStatusChange(issue.id, s)}
                    />
                  </TableCell>
                  <TableCell>
                    <AssigneeSelect
                      users={users}
                      value={issue.assignee?.id ?? null}
                      onChange={(a) => onAssigneeChange(issue.id, a)}
                    />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(issue.createdAt), {
                      addSuffix: true,
                      locale: dateFnsLocale,
                    })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("saveView")}</DialogTitle>
          </DialogHeader>
          <Input
            value={viewName}
            onChange={(e) => setViewName(e.target.value)}
            placeholder={t("viewNamePlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSaveView();
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={onSaveView} disabled={!viewName.trim()}>
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
