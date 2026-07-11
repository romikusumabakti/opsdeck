"use client";

import { formatDistanceToNow } from "date-fns";
import { CircleDot, LayoutGrid, List, Plus, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import type { IssueWithMeta } from "@/actions/issues";
import { createIssue, setIssueStatus, updateIssue } from "@/actions/issues";
import {
  type AssignableUser,
  AssigneeSelect,
  IssueBoard,
  type IssueType,
  type MilestoneOption,
  MilestoneSelect,
  type Priority,
  PrioritySelect,
  type Status,
  StatusSelect,
  type Swimlane,
  TypeIcon,
  TypeSelect,
} from "@/components/issues-board";
import { LabelChips } from "@/components/label-ui";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { Link, useRouter } from "@/i18n/navigation";
import { getDateFnsLocale } from "@/lib/date-fns-locale";

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
  const locale = useLocale();
  const dateFnsLocale = getDateFnsLocale(locale);
  const router = useRouter();

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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
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
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-12 text-center">
          <CircleDot className="size-6 text-muted-foreground" />
          <div>
            <p className="font-medium">{t("empty")}</p>
            <p className="text-sm text-muted-foreground">
              {t("emptyDescription")}
            </p>
          </div>
        </div>
      ) : view === "board" ? (
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
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">{t("columnKey")}</TableHead>
                <TableHead>{t("columnTitle")}</TableHead>
                <TableHead className="w-40">{t("columnStatus")}</TableHead>
                <TableHead className="w-36">{t("columnPriority")}</TableHead>
                <TableHead className="w-40">{t("columnEnvironment")}</TableHead>
                <TableHead className="w-32">{t("columnAssignee")}</TableHead>
                <TableHead className="w-32">{t("columnCreated")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((issue) => (
                <TableRow key={issue.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    <Link
                      href={`/project/${projectKey}/${issue.number}`}
                      className="hover:text-foreground hover:underline"
                    >
                      {projectKey}-{issue.number}
                    </Link>
                  </TableCell>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-2">
                      <TypeIcon type={issue.type as IssueType} />
                      <Link
                        href={`/project/${projectKey}/${issue.number}`}
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
