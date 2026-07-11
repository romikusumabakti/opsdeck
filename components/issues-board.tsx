"use client";

import {
  Bookmark,
  Bug,
  Layers,
  type LucideIcon,
  SquareCheck,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { LabelChips } from "@/components/label-ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Link } from "@/i18n/navigation";
import type { LabelLite } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

export const STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_DOT: Record<Status, string> = {
  open: "bg-amber-500",
  in_progress: "bg-blue-500",
  resolved: "bg-success",
  closed: "bg-muted-foreground",
};

export const ISSUE_TYPES = ["bug", "task", "story", "epic"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

const TYPE_ICON: Record<IssueType, LucideIcon> = {
  bug: Bug,
  task: SquareCheck,
  story: Bookmark,
  epic: Layers,
};
const TYPE_COLOR: Record<IssueType, string> = {
  bug: "text-destructive",
  task: "text-blue-500",
  story: "text-emerald-500",
  epic: "text-violet-500",
};

export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];

// Ascending urgency: muted → blue → amber → red.
export const PRIORITY_DOT: Record<Priority, string> = {
  low: "bg-muted-foreground",
  medium: "bg-blue-500",
  high: "bg-amber-500",
  urgent: "bg-destructive",
};

// A minimal shape both the project-scoped and global issue lists can produce.
export type BoardIssue = {
  id: string;
  number: number;
  title: string;
  status: Status;
  type?: IssueType;
  priority?: Priority;
  keyPrefix: string;
  envName?: string | null;
  assigneeName?: string | null;
  projectName?: string | null;
  labels?: LabelLite[];
};

// Compact status control with a colored dot, reused by the table and board.
export function StatusSelect({
  value,
  onChange,
  className,
}: {
  value: Status;
  onChange: (s: Status) => void;
  className?: string;
}) {
  const t = useTranslations("issues");
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v as Status)}>
      <SelectTrigger
        className={cn("h-8 w-full", className)}
        aria-label={t(`status.${value}`)}
      >
        <span className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", STATUS_DOT[value])} />
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent>
        {STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            <span className="flex items-center gap-2">
              <span className={cn("size-2 rounded-full", STATUS_DOT[s])} />
              {t(`status.${s}`)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Colored type glyph for compact rows (list key cell, board card).
export function TypeIcon({
  type,
  className,
}: {
  type: IssueType;
  className?: string;
}) {
  const t = useTranslations("issues");
  const Icon = TYPE_ICON[type];
  return (
    <Icon
      className={cn("size-4 shrink-0", TYPE_COLOR[type], className)}
      aria-label={t(`type.${type}`)}
    />
  );
}

// Type control, reused by the create dialog and inline cells.
export function TypeSelect({
  value,
  onChange,
  className,
}: {
  value: IssueType;
  onChange: (v: IssueType) => void;
  className?: string;
}) {
  const t = useTranslations("issues");
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v as IssueType)}>
      <SelectTrigger
        className={cn("h-8 w-full", className)}
        aria-label={t(`type.${value}`)}
      >
        <span className="flex items-center gap-2">
          <TypeIcon type={value} />
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent>
        {ISSUE_TYPES.map((ty) => (
          <SelectItem key={ty} value={ty}>
            <span className="flex items-center gap-2">
              <TypeIcon type={ty} />
              {t(`type.${ty}`)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Priority control with an urgency dot, reused by the table, board, and dialog.
export function PrioritySelect({
  value,
  onChange,
  className,
}: {
  value: Priority;
  onChange: (v: Priority) => void;
  className?: string;
}) {
  const t = useTranslations("issues");
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v as Priority)}>
      <SelectTrigger
        className={cn("h-8 w-full", className)}
        aria-label={t(`priority.${value}`)}
      >
        <span className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", PRIORITY_DOT[value])} />
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent>
        {PRIORITIES.map((p) => (
          <SelectItem key={p} value={p}>
            <span className="flex items-center gap-2">
              <span className={cn("size-2 rounded-full", PRIORITY_DOT[p])} />
              {t(`priority.${p}`)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export type AssignableUser = { id: string; name: string };

const UNASSIGNED = "__unassigned";

// Assignee picker reused by the create dialog and the inline table/board cells.
// `null` = unassigned.
export function AssigneeSelect({
  users,
  value,
  onChange,
  className,
}: {
  users: AssignableUser[];
  value: string | null;
  onChange: (assigneeId: string | null) => void;
  className?: string;
}) {
  const t = useTranslations("issues");
  return (
    <Select
      value={value ?? UNASSIGNED}
      onValueChange={(v) => onChange(!v || v === UNASSIGNED ? null : v)}
    >
      <SelectTrigger
        className={cn("h-8 w-full", className)}
        aria-label={t("assignee")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED}>{t("unassigned")}</SelectItem>
        {users.map((u) => (
          <SelectItem key={u.id} value={u.id}>
            {u.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Kanban-by-status board. Columns are the fixed status set; each card can move
// via its own StatusSelect (no drag dependency).
export function IssueBoard({
  issues,
  onStatusChange,
  showProject = false,
}: {
  issues: BoardIssue[];
  onStatusChange: (id: string, status: Status) => void;
  showProject?: boolean;
}) {
  const t = useTranslations("issues");
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {STATUSES.map((status) => {
        const column = issues.filter((i) => i.status === status);
        return (
          <div key={status} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 px-1">
              <span className={cn("size-2 rounded-full", STATUS_DOT[status])} />
              <span className="text-sm font-medium">
                {t(`status.${status}`)}
              </span>
              <span className="text-xs text-muted-foreground">
                {column.length}
              </span>
            </div>
            <div className="flex min-h-16 flex-col gap-2 rounded-lg border border-dashed p-2">
              {column.length === 0 ? (
                <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                  {t("boardEmpty")}
                </p>
              ) : (
                column.map((issue) => (
                  <div
                    key={issue.id}
                    className="flex flex-col gap-2 rounded-md border bg-card p-2.5"
                  >
                    <div className="flex items-center gap-2">
                      {issue.type ? <TypeIcon type={issue.type} /> : null}
                      {issue.priority ? (
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            PRIORITY_DOT[issue.priority]
                          )}
                        />
                      ) : null}
                      <Link
                        href={`/project/${issue.keyPrefix}/${issue.number}`}
                        className="font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                      >
                        {issue.keyPrefix}-{issue.number}
                      </Link>
                      {showProject && issue.projectName ? (
                        <span className="truncate text-[11px] text-muted-foreground">
                          · {issue.projectName}
                        </span>
                      ) : null}
                    </div>
                    <Link
                      href={`/project/${issue.keyPrefix}/${issue.number}`}
                      className="text-sm font-medium leading-snug hover:underline"
                    >
                      {issue.title}
                    </Link>
                    {issue.labels && issue.labels.length > 0 ? (
                      <LabelChips labels={issue.labels} />
                    ) : null}
                    {(issue.envName || issue.assigneeName) && (
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        {issue.envName ? <span>{issue.envName}</span> : null}
                        {issue.envName && issue.assigneeName ? (
                          <span aria-hidden="true">·</span>
                        ) : null}
                        {issue.assigneeName ? (
                          <span>{issue.assigneeName}</span>
                        ) : null}
                      </div>
                    )}
                    <StatusSelect
                      value={issue.status}
                      onChange={(s) => onStatusChange(issue.id, s)}
                    />
                  </div>
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
