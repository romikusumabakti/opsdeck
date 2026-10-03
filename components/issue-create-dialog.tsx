"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { createIssue } from "@/actions/issues";
import {
  type AssignableUser,
  AssigneeSelect,
  type IssueType,
  type MilestoneOption,
  MilestoneSelect,
  type Priority,
  PrioritySelect,
  TypeSelect,
} from "@/components/issues-board";
import { MarkdownEditor } from "@/components/markdown-editor";
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

export type Option = { id: string; name: string };
export type IssueDefaults = {
  title?: string;
  description?: string;
  type?: IssueType;
};

const NONE = "none";

export function IssueCreateDialog({
  open,
  onOpenChange,
  projectId,
  environments,
  users,
  milestones,
  defaultEnvironmentId,
  defaults,
  loading = false,
  projectPicker,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  environments: Option[];
  users: AssignableUser[];
  milestones: MilestoneOption[];
  defaultEnvironmentId: string;
  defaults?: IssueDefaults;
  loading?: boolean;
  projectPicker?: React.ReactNode;
  onCreated: () => void;
}) {
  const t = useTranslations("issues");
  const tCommon = useTranslations("common");

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
      setTitle(defaults?.title ?? "");
      setDescription(defaults?.description ?? "");
      setType(defaults?.type ?? "task");
      setPriority("medium");
      setAssigneeId(null);
      setMilestoneId(null);
      setEnvironmentId(defaultEnvironmentId || NONE);
    }
  }, [open, defaultEnvironmentId, defaults]);

  // Selections only count while they belong to the current project's lists:
  // Home lets the project change under an open form, and a stale id would be
  // rejected server-side (or, worse, picked from the wrong project).
  const envValue = environments.some((e) => e.id === environmentId)
    ? environmentId
    : NONE;
  const assigneeValue =
    assigneeId && users.some((u) => u.id === assigneeId) ? assigneeId : null;
  const milestoneValue =
    milestoneId && milestones.some((m) => m.id === milestoneId)
      ? milestoneId
      : null;

  async function submit() {
    if (!title.trim() || loading) return;
    setSaving(true);
    const result = await createIssue({
      projectId,
      title: title.trim(),
      description: description.trim(),
      type,
      priority,
      environmentId: envValue === NONE ? null : envValue,
      assigneeId: assigneeValue,
      milestoneId: milestoneValue,
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
      {/* Capped to the viewport with the fields scrolling inside: the markdown
          editor's toolbar plus its writing surface make this form taller than a
          short screen, and without the cap the header and the Create button are
          the parts that fall off. The wider breakpoint keeps the toolbar on one
          row. */}
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl max-h-[calc(100dvh-4rem)]">
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDescription")}</DialogDescription>
        </DialogHeader>
        {/* px/py + the negative margin keep focus rings from being clipped by
            the scroll container's edges. */}
        <div className="-mx-1 flex flex-col gap-4 overflow-y-auto px-1 py-1">
          {projectPicker}
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
            <span className="text-sm font-medium">{t("descriptionLabel")}</span>
            {/* Same markdown editor as the issue detail page, so what is typed
                here round-trips through the same parse/serialize. Shorter than
                the default surface — it sits in a dialog and grows as you
                type. */}
            <MarkdownEditor
              value={description}
              onChange={setDescription}
              contentClassName="min-h-[6rem]"
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">{t("environmentLabel")}</span>
            <Select
              value={envValue}
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
              value={assigneeValue}
              onChange={setAssigneeId}
            />
          </div>
          {milestones.length > 0 ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">{t("milestone")}</span>
              <MilestoneSelect
                milestones={milestones}
                value={milestoneValue}
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
            disabled={saving || loading || !title.trim()}
          >
            {saving ? t("creating") : t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
