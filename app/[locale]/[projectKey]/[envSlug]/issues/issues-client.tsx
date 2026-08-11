"use client";

import { formatDistanceToNow } from "date-fns";
import { CircleDot, LayoutGrid, List, Plus, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import type { IssueWithMeta } from "@/actions/issues";
import {
  bulkDeleteIssues,
  bulkSetStatus,
  createIssue,
  setIssueStatus,
  updateIssue,
} from "@/actions/issues";
import { useDialog } from "@/components/dialog-provider";
import {
  type AssignableUser,
  AssigneeSelect,
  IssueBoard,
  type IssueType,
  type MilestoneOption,
  MilestoneSelect,
  type Priority,
  PrioritySelect,
  STATUSES,
  type Status,
  StatusSelect,
  type Swimlane,
  TypeIcon,
  TypeSelect,
} from "@/components/issues-board";
import { LabelChips } from "@/components/label-ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { TablePager } from "@/components/ui/table-pager";
import { Textarea } from "@/components/ui/textarea";
import { Link, useRouter } from "@/i18n/navigation";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import { DEFAULT_PAGE_SIZE } from "@/lib/issue-query";

type EnvOption = { id: string; name: string };

export function IssuesClient({
  projectId,
  projectKey,
  currentEnvironmentId,
  environments,
  users,
  milestones,
  initialIssues,
}: {
  projectId: string;
  projectKey: string;
  currentEnvironmentId: string;
  environments: EnvOption[];
  users: AssignableUser[];
  milestones: MilestoneOption[];
  initialIssues: IssueWithMeta[];
}) {
  const t = useTranslations("issues");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const dateFnsLocale = getDateFnsLocale(locale);
  const router = useRouter();
  const dialog = useDialog();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  // Keyboard cursor into the table (j/k move, x select, Enter open). -1 = none.
  const [cursor, setCursor] = React.useState(-1);
  const cursorRef = React.useRef(-1);
  cursorRef.current = cursor;

  // Seed from server data; re-sync whenever the server component re-renders
  // (router.refresh after a mutation) so creator/assignee names resolve.
  const [issues, setIssues] = React.useState(initialIssues);
  React.useEffect(() => setIssues(initialIssues), [initialIssues]);

  const [query, setQuery] = React.useState("");
  const [createOpen, setCreateOpen] = React.useState(false);
  const [view, setView] = React.useState<"table" | "board">("table");
  const [swimlane, setSwimlane] = React.useState<Swimlane>("none");
  // "all" | "none" (unassigned) | a milestone id
  const [milestoneFilter, setMilestoneFilter] = React.useState("all");
  // Paging is client-side: the project's issues are already in memory, so a
  // page is a slice. It exists to bound what the browser has to lay out and
  // what the reader has to scan, not to save a round-trip.
  const [pageIndex, setPageIndex] = React.useState(0);
  const [pageSize, setPageSize] = React.useState(DEFAULT_PAGE_SIZE);

  const milestonesById = React.useMemo(
    () => Object.fromEntries(milestones.map((m) => [m.id, m.name])),
    [milestones]
  );

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return issues.filter((i) => {
      if (milestoneFilter === "none" && i.milestoneId) return false;
      if (
        milestoneFilter !== "all" &&
        milestoneFilter !== "none" &&
        i.milestoneId !== milestoneFilter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        i.title.toLowerCase().includes(q) ||
        `${projectKey}-${i.number}`.toLowerCase().includes(q)
      );
    });
  }, [issues, query, projectKey, milestoneFilter]);

  // Any change to the filtered set invalidates the page number — page 4 of the
  // old result set is rarely page 4 of the new one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on filter change.
  React.useEffect(() => setPageIndex(0), [query, milestoneFilter, pageSize]);

  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  // The board draws every column at once, so it shows the whole filtered set;
  // only the table pages.
  const pageRows = React.useMemo(
    () => visible.slice(currentPage * pageSize, (currentPage + 1) * pageSize),
    [visible, currentPage, pageSize]
  );

  async function onStatusChange(id: string, status: Status) {
    setIssues((prev) => prev.map((i) => (i.id === id ? { ...i, status } : i)));
    const result = await setIssueStatus(id, status);
    if (!result.success) {
      toast.error(t("updateFailed"));
      router.refresh();
      return;
    }
    toast.success(t("statusUpdated"));
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

  async function onPriorityChange(id: string, priority: Priority) {
    setIssues((prev) =>
      prev.map((i) => (i.id === id ? { ...i, priority } : i))
    );
    const result = await updateIssue(id, { priority });
    if (!result.success) toast.error(t("updateFailed"));
    router.refresh();
  }

  const usersById = React.useMemo(
    () => Object.fromEntries(users.map((u) => [u.id, u.name])),
    [users]
  );

  // Drop the selection whenever the underlying list changes (e.g. after a
  // refresh), so a stale id can't linger in a bulk action.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on data change only.
  React.useEffect(() => setSelected(new Set()), [initialIssues]);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // "Select all" means the rows on screen — the header checkbox can't promise
  // anything about rows the user hasn't paged to.
  function toggleAll() {
    setSelected((prev) =>
      prev.size === pageRows.length
        ? new Set()
        : new Set(pageRows.map((i) => i.id))
    );
  }

  async function onBulkStatus(status: Status) {
    const ids = [...selected];
    const result = await bulkSetStatus(ids, status);
    if (!result.success) toast.error(t("updateFailed"));
    else toast.success(t("statusUpdated"));
    setSelected(new Set());
    router.refresh();
  }

  async function onBulkDelete() {
    const ids = [...selected];
    const ok = await dialog.confirm({
      title: t("bulkDeleteTitle"),
      description: t("bulkDeleteDescription", { count: ids.length }),
      confirmText: tCommon("delete"),
      cancelText: tCommon("cancel"),
      destructive: true,
    });
    if (!ok) return;
    const result = await bulkDeleteIssues(ids);
    if (!result.success) toast.error(t("updateFailed"));
    else toast.success(t("bulkDeleted"));
    setSelected(new Set());
    router.refresh();
  }

  // Keyboard-first navigation of the table (Linear-style). Ignores keys while a
  // form control is focused so typing in the search box isn't hijacked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cursor read via ref.
  React.useEffect(() => {
    if (view !== "table") return;
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      if (pageRows.length === 0) return;
      if (e.key === "j") {
        e.preventDefault();
        setCursor((c) => Math.min((c < 0 ? -1 : c) + 1, pageRows.length - 1));
      } else if (e.key === "k") {
        e.preventDefault();
        setCursor((c) => Math.max((c < 0 ? pageRows.length : c) - 1, 0));
      } else if (e.key === "x") {
        const i = cursorRef.current;
        if (i >= 0 && i < pageRows.length) {
          e.preventDefault();
          toggleSelected(pageRows[i].id);
        }
      } else if (e.key === "Enter") {
        const i = cursorRef.current;
        if (i >= 0 && i < pageRows.length) {
          e.preventDefault();
          router.push(`/${projectKey}/issues/${pageRows[i].number}`);
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [view, pageRows, projectKey, router]);

  return (
    // `flex-1 min-h-0` so the list scrolls inside this panel instead of growing
    // the page — the toolbar and the pager stay put while the rows move.
    <div className="flex flex-1 min-h-0 flex-col gap-4">
      <div className="shrink-0 flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="ps-9"
            aria-label={t("searchPlaceholder")}
          />
        </div>
        {milestones.length > 0 ? (
          <Select
            value={milestoneFilter}
            onValueChange={(v) => setMilestoneFilter(v ?? "all")}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allMilestones")}</SelectItem>
              <SelectItem value="none">{t("noMilestone")}</SelectItem>
              {milestones.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <div className="flex items-center gap-2 sm:ms-auto">
          {view === "board" ? (
            <Select
              value={swimlane}
              onValueChange={(v) => setSwimlane((v ?? "none") as Swimlane)}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("groupNone")}</SelectItem>
                <SelectItem value="assignee">{t("groupAssignee")}</SelectItem>
                <SelectItem value="milestone">{t("groupMilestone")}</SelectItem>
              </SelectContent>
            </Select>
          ) : null}
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
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            {t("new")}
          </Button>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="shrink-0 flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-12 text-center">
          <CircleDot className="size-6 text-muted-foreground" />
          <div>
            <p className="font-medium">{t("empty")}</p>
            <p className="text-sm text-muted-foreground">
              {t("emptyDescription")}
            </p>
          </div>
        </div>
      ) : view === "board" ? (
        // The board has no bounded height of its own, so it gets the scroll
        // container here; columns grow and this wrapper scrolls.
        <div className="flex-1 min-h-0 overflow-y-auto">
          <IssueBoard
            issues={visible.map((i) => ({
              id: i.id,
              number: i.number,
              title: i.title,
              status: i.status as Status,
              type: i.type as IssueType,
              priority: i.priority as Priority,
              keyPrefix: projectKey,
              envName: i.environment?.name ?? null,
              assigneeName: i.assignee?.name ?? null,
              milestoneName: i.milestoneId
                ? (milestonesById[i.milestoneId] ?? null)
                : null,
              labels: i.labels,
            }))}
            onStatusChange={onStatusChange}
            swimlane={swimlane}
          />
        </div>
      ) : (
        <div className="flex flex-1 min-h-0 flex-col gap-2">
          {selected.size > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
              <span className="text-sm font-medium">
                {t("selectedCount", { count: selected.size })}
              </span>
              <Select onValueChange={(v) => v && onBulkStatus(v as Status)}>
                <SelectTrigger className="h-8 w-40">
                  <SelectValue placeholder={t("bulkStatus")} />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`status.${s}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                onClick={onBulkDelete}
              >
                {tCommon("delete")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelected(new Set())}
              >
                {t("clearSelection")}
              </Button>
            </div>
          ) : null}
          <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
            {/* The table container is the scroll box (`flex-1 min-h-0`), so the
                `sticky` header pins to it while rows scroll underneath. */}
            <Table containerClassName="flex-1 min-h-0">
              <TableHeader className="sticky top-0 z-10 [&_th]:bg-card [&_th]:border-b">
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={
                        pageRows.length > 0 && selected.size === pageRows.length
                      }
                      onCheckedChange={toggleAll}
                      aria-label={t("selectAll")}
                    />
                  </TableHead>
                  <TableHead className="w-24">{t("columnKey")}</TableHead>
                  <TableHead>{t("columnTitle")}</TableHead>
                  <TableHead className="w-40">{t("columnStatus")}</TableHead>
                  <TableHead className="w-36">{t("columnPriority")}</TableHead>
                  <TableHead className="w-40">
                    {t("columnEnvironment")}
                  </TableHead>
                  <TableHead className="w-32">{t("columnAssignee")}</TableHead>
                  <TableHead className="w-32">{t("columnCreated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((issue, idx) => (
                  <TableRow
                    key={issue.id}
                    className={cursor === idx ? "bg-accent/60" : undefined}
                  >
                    <TableCell>
                      <Checkbox
                        checked={selected.has(issue.id)}
                        onCheckedChange={() => toggleSelected(issue.id)}
                        aria-label={t("selectRow")}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      <Link
                        href={`/${projectKey}/issues/${issue.number}`}
                        className="hover:text-foreground hover:underline"
                      >
                        {projectKey}-{issue.number}
                      </Link>
                    </TableCell>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        <TypeIcon type={issue.type as IssueType} />
                        <Link
                          href={`/${projectKey}/issues/${issue.number}`}
                          className="hover:underline"
                        >
                          {issue.title}
                        </Link>
                        <LabelChips labels={issue.labels} />
                        {issue.milestoneId ? (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                            {milestonesById[issue.milestoneId]}
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusSelect
                        value={issue.status as Status}
                        onChange={(s) => onStatusChange(issue.id, s)}
                      />
                    </TableCell>
                    <TableCell>
                      <PrioritySelect
                        value={issue.priority as Priority}
                        onChange={(p) => onPriorityChange(issue.id, p)}
                      />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground truncate">
                      {issue.environment?.name ?? (
                        <span className="italic">{t("allEnvironments")}</span>
                      )}
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
          <TablePager
            pageIndex={currentPage}
            pageSize={pageSize}
            total={visible.length}
            onPageIndexChange={setPageIndex}
            onPageSizeChange={setPageSize}
          />
        </div>
      )}

      <CreateIssueDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        environments={environments}
        users={users}
        milestones={milestones}
        defaultEnvironmentId={currentEnvironmentId}
        onCreated={() => {
          setCreateOpen(false);
          router.refresh();
        }}
      />
    </div>
  );
}

function CreateIssueDialog({
  open,
  onOpenChange,
  projectId,
  environments,
  users,
  milestones,
  defaultEnvironmentId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  environments: EnvOption[];
  users: AssignableUser[];
  milestones: MilestoneOption[];
  defaultEnvironmentId: string;
  onCreated: () => void;
}) {
  const t = useTranslations("issues");
  const tCommon = useTranslations("common");

  const NONE = "none";
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [type, setType] = React.useState<IssueType>("task");
  const [priority, setPriority] = React.useState<Priority>("medium");
  const [assigneeId, setAssigneeId] = React.useState<string | null>(null);
  const [milestoneId, setMilestoneId] = React.useState<string | null>(null);
  // Empty default (e.g. from the project overview, which has no "current" env)
  // falls back to the "None" option.
  const [environmentId, setEnvironmentId] = React.useState(
    defaultEnvironmentId || NONE
  );
  const [saving, setSaving] = React.useState(false);

  // Reset the form each time the dialog opens.
  React.useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      setType("task");
      setPriority("medium");
      setAssigneeId(null);
      setMilestoneId(null);
      setEnvironmentId(defaultEnvironmentId || NONE);
    }
  }, [open, defaultEnvironmentId]);

  async function submit() {
    if (!title.trim()) return;
    setSaving(true);
    const result = await createIssue({
      projectId,
      title: title.trim(),
      description: description.trim(),
      type,
      priority,
      environmentId: environmentId === NONE ? null : environmentId,
      assigneeId,
      milestoneId,
    });
    setSaving(false);
    if (!result.success) {
      toast.error(t("createFailed"));
      return;
    }
    toast.success(t("createdSuccess"));
    onCreated();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="issue-title">
              {t("titleLabel")}
            </label>
            <Input
              id="issue-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("titlePlaceholder")}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">{t("typeLabel")}</span>
              <TypeSelect value={type} onChange={setType} />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">{t("priorityLabel")}</span>
              <PrioritySelect value={priority} onChange={setPriority} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="issue-description">
              {t("descriptionLabel")}
            </label>
            <Textarea
              id="issue-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">{t("environmentLabel")}</span>
            <Select
              value={environmentId}
              onValueChange={(v) => setEnvironmentId(v ?? NONE)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("none")}</SelectItem>
                {environments.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">{t("assignee")}</span>
            <AssigneeSelect
              users={users}
              value={assigneeId}
              onChange={setAssigneeId}
            />
          </div>
          {milestones.length > 0 ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">{t("milestone")}</span>
              <MilestoneSelect
                milestones={milestones}
                value={milestoneId}
                onChange={setMilestoneId}
              />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {tCommon("cancel")}
          </Button>
          <Button
            type="button"
            onClick={submit}
            disabled={saving || !title.trim()}
          >
            {saving ? t("creating") : t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
