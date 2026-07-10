"use client";

import { formatDistanceToNow } from "date-fns";
import { CircleDot, LayoutGrid, List, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import type { GlobalIssue } from "@/actions/issues";
import { setIssueStatus, updateIssue } from "@/actions/issues";
import {
  type AssignableUser,
  AssigneeSelect,
  IssueBoard,
  type Status,
  StatusSelect,
} from "@/components/issues-board";
import { Button } from "@/components/ui/button";
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
}: {
  initialIssues: GlobalIssue[];
  currentUserId: string;
  users: AssignableUser[];
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
  const [status, setStatus] = React.useState<string>(ALL);
  const [projectId, setProjectId] = React.useState<string>(ALL);
  const [mineOnly, setMineOnly] = React.useState(false);
  const [view, setView] = React.useState<"table" | "board">("table");

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
  }, [issues, query, status, projectId, mineOnly, currentUserId]);

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
                    <Link
                      href={`/project/${issue.project.key}/${issue.number}`}
                      className="hover:underline"
                    >
                      {issue.title}
                    </Link>
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
    </div>
  );
}
