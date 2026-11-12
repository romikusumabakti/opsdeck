import {
  Bookmark,
  Bug,
  Layers,
  type LucideIcon,
  SquareCheck,
} from "lucide-react";
import { useTranslations } from "use-intl";
import { COMPACT_TRIGGER } from "@/components/compact-trigger";
import { LabelChips } from "@/components/label-ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserAvatar } from "@/components/user/user-avatar";
import { UserName } from "@/components/user/user-name";
import { Link } from "@/i18n/navigation";
import type { LabelLite } from "@/lib/db/schema";
import type { UserRef } from "@/lib/types";
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
  assignee?: UserRef | null;
  projectName?: string | null;
  labels?: LabelLite[];
};

export type Swimlane = "none" | "assignee";

export type SelectVariant = "default" | "compact";

function triggerClass(variant: SelectVariant, className?: string) {
  return cn(variant === "compact" ? COMPACT_TRIGGER : "h-8 w-full", className);
}

// Status control with a colored dot, reused by the table and board.
// Pass variant="compact" for dense rows and cards.
export function StatusSelect({
  value,
  onChange,
  className,
  variant = "default",
}: {
  value: Status;
  onChange: (s: Status) => void;
  className?: string;
  variant?: SelectVariant;
}) {
  const t = useTranslations("issues");
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v as Status)}>
      <SelectTrigger
        className={triggerClass(variant, className)}
        aria-label={t(`status.${value}`)}
      >
        {/* No dot here: SelectValue renders the selected item's own content
            (dot + label) via Base UI's ItemText, so adding one would double it. */}
        <SelectValue />
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
        {/* SelectValue already renders the selected item's icon + label. */}
        <SelectValue />
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
// Pass variant="compact" for dense rows and cards.
export function PrioritySelect({
  value,
  onChange,
  className,
  variant = "default",
}: {
  value: Priority;
  onChange: (v: Priority) => void;
  className?: string;
  variant?: SelectVariant;
}) {
  const t = useTranslations("issues");
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v as Priority)}>
      <SelectTrigger
        className={triggerClass(variant, className)}
        aria-label={t(`priority.${value}`)}
      >
        {/* SelectValue already renders the selected item's dot + label. */}
        <SelectValue />
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

export type AssignableUser = UserRef & {
  status?: { emoji: string | null; text: string | null } | null;
};

const UNASSIGNED = "__unassigned";

// Assignee picker reused by the create dialog and the inline table/board cells.
// `null` = unassigned. Pass variant="compact" for dense rows and cards.
export function AssigneeSelect({
  users,
  value,
  onChange,
  className,
  variant = "default",
}: {
  users: AssignableUser[];
  value: string | null;
  onChange: (assigneeId: string | null) => void;
  className?: string;
  variant?: SelectVariant;
}) {
  const t = useTranslations("issues");
  return (
    <Select
      value={value ?? UNASSIGNED}
      onValueChange={(v) => onChange(!v || v === UNASSIGNED ? null : v)}
    >
      <SelectTrigger
        className={triggerClass(variant, className)}
        aria-label={t("assignee")}
      >
        {/* min-w-0 lets the value shrink so a long name truncates. */}
        <SelectValue className="min-w-0" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED}>{t("unassigned")}</SelectItem>
        {users.map((u) => (
          <SelectItem key={u.id} value={u.id}>
            <span className="flex min-w-0 items-center gap-2">
              <UserAvatar user={u} size="xs" />
              <span className="truncate">{u.name}</span>
              {u.status?.emoji && (
                <span title={u.status.text ?? undefined}>{u.status.emoji}</span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Kanban-by-status board. Columns are the fixed status set; each card can move
// via its own StatusSelect (no drag dependency).
function IssueCard({
  issue,
  showProject,
  onStatusChange,
}: {
  issue: BoardIssue;
  showProject: boolean;
  onStatusChange: (id: string, status: Status) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card p-2.5">
      <div className="flex items-center gap-2">
        {issue.type ? <TypeIcon type={issue.type} /> : null}
        {issue.priority ? (
          <span
            className={cn("size-2 rounded-full", PRIORITY_DOT[issue.priority])}
          />
        ) : null}
        <Link
          href={`/${issue.keyPrefix}/issues/${issue.number}`}
          className="font-mono text-sm text-muted-foreground hover:text-foreground hover:underline"
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
        href={`/${issue.keyPrefix}/issues/${issue.number}`}
        className="text-sm font-medium leading-snug hover:underline"
      >
        {issue.title}
      </Link>
      {issue.labels && issue.labels.length > 0 ? (
        <LabelChips labels={issue.labels} max={3} />
      ) : null}
      {issue.envName || issue.assignee ? (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          {issue.envName ? <span>{issue.envName}</span> : null}
          {issue.envName && issue.assignee ? (
            <span aria-hidden="true">·</span>
          ) : null}
          {issue.assignee ? <UserName user={issue.assignee} avatar /> : null}
        </div>
      ) : null}
      <StatusSelect
        variant="compact"
        value={issue.status}
        onChange={(s) => onStatusChange(issue.id, s)}
      />
    </div>
  );
}

// The status-column kanban for one set of issues. Reused per swimlane band.
function StatusColumns({
  issues,
  showProject,
  onStatusChange,
}: {
  issues: BoardIssue[];
  showProject: boolean;
  onStatusChange: (id: string, status: Status) => void;
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
                  <IssueCard
                    key={issue.id}
                    issue={issue}
                    showProject={showProject}
                    onStatusChange={onStatusChange}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Kanban-by-status board. Optional swimlanes split the issues into horizontal
// bands by assignee, each an independent status kanban; each card
// still moves via its own StatusSelect (no drag dependency).
export function IssueBoard({
  issues,
  onStatusChange,
  showProject = false,
  swimlane = "none",
}: {
  issues: BoardIssue[];
  onStatusChange: (id: string, status: Status) => void;
  showProject?: boolean;
  swimlane?: Swimlane;
}) {
  const t = useTranslations("issues");

  if (swimlane !== "assignee") {
    return (
      <StatusColumns
        issues={issues}
        showProject={showProject}
        onStatusChange={onStatusChange}
      />
    );
  }

  const noneLabel = t("unassigned");
  // Group, keeping the "none" bucket last and the rest alphabetical.
  const groups = new Map<string, BoardIssue[]>();
  for (const i of issues) {
    const key = i.assignee?.name || noneLabel;
    const arr = groups.get(key);
    if (arr) arr.push(i);
    else groups.set(key, [i]);
  }
  const ordered = [...groups.keys()].sort((a, b) => {
    if (a === noneLabel) return 1;
    if (b === noneLabel) return -1;
    return a.localeCompare(b);
  });

  return (
    <div className="flex flex-col gap-6">
      {ordered.map((group) => (
        <div key={group} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{group}</span>
            <span className="text-xs text-muted-foreground">
              {groups.get(group)?.length ?? 0}
            </span>
          </div>
          <StatusColumns
            issues={groups.get(group) ?? []}
            showProject={showProject}
            onStatusChange={onStatusChange}
          />
        </div>
      ))}
    </div>
  );
}
