import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import {
  AssigneeProperty,
  EnvironmentProperty,
  LabelsProperty,
  ParentProperty,
  PriorityProperty,
  ProjectProperty,
  StatusProperty,
  TypeProperty,
} from "@/components/issue-property-trigger";
import type { IssueType, Priority, Status } from "@/components/issues-board";
import type { EditorHandle } from "@/components/knowledge-editor";
import { MarkdownEditor } from "@/components/markdown-editor";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { createIssue, getIssueFormOptionsQuery } from "@/web/api/issues";
import { listTreeNodesQuery } from "@/web/api/knowledge";

export type IssueDefaults = {
  title?: string;
  description?: string;
  type?: IssueType;
};

/** The Project chip (Home and global entry points only). */
export type ProjectChoice = {
  projects: { id: string; name: string; key: string }[];
  onChange: (projectId: string) => void;
};

/**
 * The New issue dialog: a large borderless title, the description editor and
 * a chip row for the properties, all sent in one create request. Ctrl/⌘+Enter
 * creates from anywhere in it (Enter in the title does not). With "Create
 * more" on, a create keeps the dialog open with the chosen properties, clears
 * the title and description and puts the caret back in the title.
 *
 * The project's pickers (environments, people, labels, parent candidates) and
 * the linkable documents load while it is open.
 */
export function IssueCreateDialog({
  open,
  onOpenChange,
  projectId,
  projectKey,
  defaultEnvironmentId,
  defaults,
  projectChoice,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** For parent references (`KEY-12`); taken from `projectChoice` there. */
  projectKey?: string;
  defaultEnvironmentId: string;
  defaults?: IssueDefaults;
  projectChoice?: ProjectChoice;
  /** After each create. Closing is the dialog's own (unless Create more). */
  onCreated?: () => void;
}) {
  // Stays on for the page's life, as the switch was left.
  const [createMore, setCreateMore] = React.useState(false);

  // A new prefill (Home's buttons) restarts the form even while it is open;
  // a project change alone does not.
  const [formKey, setFormKey] = React.useState(0);
  const [seen, setSeen] = React.useState({ defaults, defaultEnvironmentId });
  if (
    seen.defaults !== defaults ||
    seen.defaultEnvironmentId !== defaultEnvironmentId
  ) {
    setSeen({ defaults, defaultEnvironmentId });
    setFormKey((k) => k + 1);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Capped to the viewport with the title and description scrolling
          inside, so the chips and Create stay on screen. */}
      <DialogContent className="flex max-h-[calc(100dvh-4rem)] flex-col gap-0 p-0 sm:max-w-2xl">
        {/* Mounted only while open: each open starts a fresh form. */}
        <IssueCreateForm
          key={formKey}
          projectId={projectId}
          projectKey={
            projectChoice?.projects.find((p) => p.id === projectId)?.key ??
            projectKey
          }
          defaultEnvironmentId={defaultEnvironmentId}
          defaults={defaults}
          projectChoice={projectChoice}
          createMore={createMore}
          onCreateMoreChange={setCreateMore}
          onCreated={() => {
            onCreated?.();
            if (!createMore) onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function IssueCreateForm({
  projectId,
  projectKey,
  defaultEnvironmentId,
  defaults,
  projectChoice,
  createMore,
  onCreateMoreChange,
  onCreated,
}: {
  projectId: string;
  projectKey?: string;
  defaultEnvironmentId: string;
  defaults?: IssueDefaults;
  projectChoice?: ProjectChoice;
  createMore: boolean;
  onCreateMoreChange: (on: boolean) => void;
  onCreated: () => void;
}) {
  const t = useTranslations("issues");
  const titleRef = React.useRef<HTMLInputElement>(null);
  const descriptionRef = React.useRef<EditorHandle>(null);
  const createMoreId = React.useId();

  const [title, setTitle] = React.useState(defaults?.title ?? "");
  const [description, setDescription] = React.useState(
    defaults?.description ?? ""
  );
  const [type, setType] = React.useState<IssueType>(defaults?.type ?? "task");
  const [priority, setPriority] = React.useState<Priority>("medium");
  const [status, setStatus] = React.useState<Status>("open");
  const [assigneeId, setAssigneeId] = React.useState<string | null>(null);
  // Empty default (e.g. the project issue list, which has no "current" env)
  // means none.
  const [environmentId, setEnvironmentId] = React.useState<string | null>(
    defaultEnvironmentId || null
  );
  const [parentId, setParentId] = React.useState<string | null>(null);
  const [labelIds, setLabelIds] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);

  const options = useQuery(getIssueFormOptionsQuery(projectId));
  const loadFailed = options.isError;
  React.useEffect(() => {
    if (loadFailed) toast.error(t("optionsLoadFailed"));
  }, [loadFailed, t]);
  // Only documents the caller can see (the tree is filtered server-side); a
  // failed load just leaves "Link to document" out.
  const docs = useQuery(listTreeNodesQuery());
  const linkableDocs = React.useMemo(
    () => (docs.data ?? []).map((n) => ({ title: n.title, slug: n.slug })),
    [docs.data]
  );

  const environments = options.data?.environments ?? [];
  const users = options.data?.users ?? [];
  const labels = options.data?.labels ?? [];
  const parents = options.data?.parents ?? [];
  const loading = options.data === undefined;

  // Selections only count while they belong to the current project's lists:
  // the project can change under an open form (and Create more keeps the
  // properties), and a stale id would be rejected server-side.
  const envValue =
    environmentId && environments.some((e) => e.id === environmentId)
      ? environmentId
      : null;
  const assigneeValue =
    assigneeId && users.some((u) => u.id === assigneeId) ? assigneeId : null;
  const parentValue =
    parentId && parents.some((p) => p.id === parentId) ? parentId : null;
  const labelValue = labelIds.filter((id) => labels.some((l) => l.id === id));

  const canSubmit = title.trim() !== "" && !loading && !saving;

  async function submit() {
    if (!canSubmit) return;
    // The editor reports typing after a short debounce; Ctrl/⌘+Enter right
    // after a keystroke would otherwise send the text from before it.
    const body = descriptionRef.current?.flush() ?? description;
    setSaving(true);
    const result = await createIssue({
      projectId,
      title: title.trim(),
      description: body.trim(),
      type,
      priority,
      status,
      environmentId: envValue,
      assigneeId: assigneeValue,
      parentId: parentValue,
      labelIds: labelValue,
    });
    setSaving(false);
    if (!result.success) {
      toast.error(t("createFailed"));
      return;
    }
    toast.success(t("createdSuccess"));
    if (createMore) {
      setTitle("");
      setDescription("");
      titleRef.current?.focus();
    }
    onCreated();
  }

  // Capture phase: ahead of the editor, which would otherwise take
  // Ctrl/⌘+Enter as a line break.
  function onKeyDownCapture(e: React.KeyboardEvent) {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
    if (e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    void submit();
  }

  const chip = "chip" as const;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDownCapture={onKeyDownCapture}
    >
      <DialogHeader className="px-5 pt-4 pe-12">
        <DialogTitle className="text-sm font-medium text-muted-foreground">
          {t("createTitle")}
        </DialogTitle>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-5 py-3">
        <input
          ref={titleRef}
          aria-label={t("titleLabel")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("titlePlaceholder")}
          maxLength={300}
          className="w-full rounded-sm bg-transparent text-xl font-semibold outline-none placeholder:text-muted-foreground/70 focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <MarkdownEditor
          ref={descriptionRef}
          borderless
          value={description}
          onChange={setDescription}
          linkableDocs={linkableDocs}
          contentClassName="min-h-[6rem]"
        />
      </div>
      <div
        role="group"
        aria-label={t("properties")}
        className="flex flex-wrap items-center gap-1.5 px-5 pb-4"
      >
        {projectChoice ? (
          <ProjectProperty
            variant={chip}
            projects={projectChoice.projects}
            value={projectId}
            onChange={projectChoice.onChange}
          />
        ) : null}
        <StatusProperty variant={chip} value={status} onChange={setStatus} />
        <PriorityProperty
          variant={chip}
          value={priority}
          onChange={setPriority}
        />
        <AssigneeProperty
          variant={chip}
          users={users}
          value={assigneeValue}
          onChange={setAssigneeId}
        />
        <TypeProperty variant={chip} value={type} onChange={setType} />
        {/* Labels and Parent only when there is something to pick, as in
            the issue page's sidebar (a picked one is always in its list). */}
        {labels.length > 0 ? (
          <LabelsProperty
            variant={chip}
            allLabels={labels}
            value={labelValue}
            onChange={setLabelIds}
          />
        ) : null}
        <EnvironmentProperty
          variant={chip}
          environments={environments}
          value={envValue}
          onChange={setEnvironmentId}
        />
        {parents.length > 0 ? (
          <ParentProperty
            variant={chip}
            parents={parents}
            projectKey={projectKey}
            value={parentValue}
            onChange={setParentId}
          />
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-4 border-t px-5 py-3">
        <div className="flex items-center gap-2">
          <Switch
            id={createMoreId}
            checked={createMore}
            onCheckedChange={onCreateMoreChange}
          />
          <Label htmlFor={createMoreId} className="font-normal">
            {t("createMore")}
          </Label>
        </div>
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          aria-keyshortcuts="Control+Enter Meta+Enter"
        >
          {saving ? t("creating") : t("create")}
        </Button>
      </div>
    </div>
  );
}
