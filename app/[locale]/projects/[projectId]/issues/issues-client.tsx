"use client";

import { formatDistanceToNow } from "date-fns";
import { CircleDot, Plus, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import type { IssueWithMeta } from "@/actions/issues";
import { createIssue, setIssueStatus } from "@/actions/issues";
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
import { useRouter } from "@/i18n/navigation";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import { cn } from "@/lib/utils";

const STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
type Status = (typeof STATUSES)[number];

const STATUS_DOT: Record<Status, string> = {
  open: "bg-amber-500",
  in_progress: "bg-blue-500",
  resolved: "bg-success",
  closed: "bg-muted-foreground",
};

type EnvOption = { id: string; name: string };

export function IssuesClient({
  projectId,
  projectKey,
  currentEnvironmentId,
  environments,
  initialIssues,
}: {
  projectId: string;
  projectKey: string;
  currentEnvironmentId: string;
  environments: EnvOption[];
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

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return issues;
    return issues.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        `${projectKey}-${i.number}`.toLowerCase().includes(q)
    );
  }, [issues, query, projectKey]);

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
        <Button className="sm:ms-auto" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          {t("new")}
        </Button>
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
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">{t("columnKey")}</TableHead>
                <TableHead>{t("columnTitle")}</TableHead>
                <TableHead className="w-40">{t("columnStatus")}</TableHead>
                <TableHead className="w-40">{t("columnEnvironment")}</TableHead>
                <TableHead className="w-32">{t("columnAssignee")}</TableHead>
                <TableHead className="w-32">{t("columnCreated")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((issue) => (
                <TableRow key={issue.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {projectKey}-{issue.number}
                  </TableCell>
                  <TableCell className="font-medium">{issue.title}</TableCell>
                  <TableCell>
                    <StatusSelect
                      value={issue.status as Status}
                      onChange={(s) => onStatusChange(issue.id, s)}
                      label={(s) => t(`status.${s}`)}
                    />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground truncate">
                    {issue.environment?.name ?? (
                      <span className="italic">{t("allEnvironments")}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground truncate">
                    {issue.assignee?.name ?? (
                      <span className="italic">{t("unassigned")}</span>
                    )}
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
        defaultEnvironmentId={currentEnvironmentId}
        onCreated={() => {
          setCreateOpen(false);
          router.refresh();
        }}
      />
    </div>
  );
}

function StatusSelect({
  value,
  onChange,
  label,
}: {
  value: Status;
  onChange: (s: Status) => void;
  label: (s: Status) => string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Status)}>
      <SelectTrigger className="h-8 w-full" aria-label={label(value)}>
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
              {label(s)}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function CreateIssueDialog({
  open,
  onOpenChange,
  projectId,
  environments,
  defaultEnvironmentId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  environments: EnvOption[];
  defaultEnvironmentId: string;
  onCreated: () => void;
}) {
  const t = useTranslations("issues");
  const tCommon = useTranslations("common");

  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [environmentId, setEnvironmentId] =
    React.useState(defaultEnvironmentId);
  const [saving, setSaving] = React.useState(false);

  // Reset the form each time the dialog opens.
  React.useEffect(() => {
    if (open) {
      setTitle("");
      setDescription("");
      setEnvironmentId(defaultEnvironmentId);
    }
  }, [open, defaultEnvironmentId]);

  async function submit() {
    if (!title.trim()) return;
    setSaving(true);
    const result = await createIssue({
      projectId,
      title: title.trim(),
      description: description.trim(),
      environmentId: environmentId === "none" ? null : environmentId,
    });
    setSaving(false);
    if (!result.success) {
      toast.error(t("createFailed"));
      return;
    }
    toast.success(t("createdSuccess"));
    onCreated();
  }

  const NONE = "none";

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
