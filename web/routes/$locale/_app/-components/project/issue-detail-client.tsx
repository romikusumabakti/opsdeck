import { useQuery } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleX,
  Download,
  Paperclip,
  RotateCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { CopyButton } from "@/components/copy-button";
import {
  type AssignableUser,
  type IssueType,
  TypeIcon,
} from "@/components/issues-board";
import type { EditorHandle } from "@/components/knowledge-editor";
import { MarkdownContent } from "@/components/markdown-content";
import { MarkdownEditor } from "@/components/markdown-editor";
import { MentionTextarea } from "@/components/mention-textarea";
import { RelativeTime } from "@/components/relative-time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TooltipHint } from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user/user-avatar";
import { UserName } from "@/components/user/user-name";
import { Link, useRouter } from "@/i18n/navigation";
import type { LabelLite } from "@/lib/db/schema";
import { formatBytes } from "@/lib/utils";
import {
  deleteIssueAttachment,
  type IssueAttachmentRow,
} from "@/web/api/issue-attachments";
import type { IssueDetail } from "@/web/api/issues";
import { addComment, updateIssue } from "@/web/api/issues";
import { listTreeNodesQuery } from "@/web/api/knowledge";
import { setIssueLabels } from "@/web/api/labels";
import { recordTestRun, type TestRunRow } from "@/web/api/test-runs";
import {
  IssueDatesLine,
  type IssuePatch,
  IssuePropertiesSidebar,
  IssuePropertyChips,
} from "./issue-detail-properties";

type EnvOption = { id: string; name: string };
type TextField = "title" | "description";
type SaveState = "idle" | "saving" | "saved" | "error";

/** The server version the page's title/description edits are based on. Its
 *  `updatedAt` goes out with every text save (`expectedUpdatedAt`). */
type Base = { title: string; description: string; updatedAt: string };

const baseOf = (row: {
  title: string;
  description: string;
  updatedAt: string | Date;
}): Base => ({
  title: row.title,
  description: row.description,
  updatedAt: new Date(row.updatedAt).toISOString(),
});

/**
 * The issue page (Linear pattern): from `lg` a main column (title,
 * description, subtasks, attachments, test runs, comments) next to a
 * properties sidebar; below `lg` the properties are a chip row under the
 * title.
 *
 * Title and description save on blur (the title also on Enter), only when
 * changed, carrying the `updatedAt` the page last saw: a stale save is refused
 * (409 `issueChanged`) and the page shows "Changed by someone else" with
 * Reload, which loads the server version and keeps the user's text on the
 * page to copy. Every update — property changes included — goes through one
 * queue, so each request sees the `updatedAt` the previous one returned.
 * Without `canEdit` (`issue: write`) everything is read-only.
 *
 * Keyed by the issue: the router keeps the page mounted when only the params
 * change (a Subtasks link), and no local state — text, labels, the base
 * version — may carry over to another issue.
 */
export function IssueDetailClient(props: IssueDetailProps) {
  return <IssueDetailView key={props.issue.id} {...props} />;
}

type IssueDetailProps = {
  issue: IssueDetail;
  users: AssignableUser[];
  environments: EnvOption[];
  siblings: { id: string; number: number; title: string }[];
  attachments: IssueAttachmentRow[];
  testRuns: TestRunRow[];
  allLabels: LabelLite[];
  /** May change the issue (`issue: write`, as the server checks). */
  canEdit: boolean;
  /** Loads the issue's current server version (Reload after a conflict). */
  onReload: () => Promise<IssueDetail | null>;
};

function IssueDetailView({
  issue,
  users,
  environments,
  siblings,
  attachments,
  testRuns,
  allLabels,
  canEdit,
  onReload,
}: IssueDetailProps) {
  const t = useTranslations("issueDetail");
  const tIssues = useTranslations("issues");
  const router = useRouter();

  const [title, setTitle] = React.useState(issue.title);
  const [description, setDescription] = React.useState(issue.description);
  const [labelIds, setLabelIds] = React.useState(issue.labels.map((l) => l.id));
  // The label set the server last confirmed (a successful toggle, or a
  // refetch). Once no toggle is waiting, the page shows it: a failed toggle
  // falls back to it, and a refetch brings in someone else's change.
  const serverLabelsRef = React.useRef(labelIds);
  const pendingLabelsRef = React.useRef(0);
  const issueLabelKey = issue.labels.map((l) => l.id).join(",");
  React.useEffect(() => {
    const ids = issueLabelKey ? issueLabelKey.split(",") : [];
    serverLabelsRef.current = ids;
    if (pendingLabelsRef.current === 0) setLabelIds(ids);
  }, [issueLabelKey]);
  const titleRef = React.useRef<HTMLInputElement>(null);
  const descriptionRef = React.useRef<EditorHandle>(null);
  const keptRef = React.useRef<HTMLDivElement>(null);
  // Set by Reload; the effect below moves focus once the new state is drawn.
  const [focusAfterReload, setFocusAfterReload] = React.useState(false);
  const [comment, setComment] = React.useState("");
  const [posting, setPosting] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [testNote, setTestNote] = React.useState("");
  const [recording, setRecording] = React.useState(false);

  const docs = useQuery({ ...listTreeNodesQuery(), enabled: canEdit });
  const linkableDocs = React.useMemo(
    () => (docs.data ?? []).map((n) => ({ title: n.title, slug: n.slug })),
    [docs.data]
  );

  // --- Conflict-safe text saves -------------------------------------------
  const baseRef = React.useRef<Base>(baseOf(issue));
  const queueRef = React.useRef<Promise<unknown>>(Promise.resolve());
  const conflictRef = React.useRef(false);
  const [saveState, setSaveState] = React.useState<
    Record<TextField, SaveState>
  >({ title: "idle", description: "idle" });
  const [conflict, setConflict] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);
  // The user's own text after a Reload replaced it, to copy from.
  const [kept, setKept] = React.useState<Partial<
    Record<TextField, string>
  > | null>(null);

  const markSave = (field: TextField, state: SaveState) =>
    setSaveState((s) => ({ ...s, [field]: state }));

  /** Runs updates one at a time, in order. */
  function enqueue(job: () => Promise<void>): Promise<void> {
    const next = queueRef.current.then(job, job);
    queueRef.current = next.catch(() => {});
    return next;
  }

  // A newer server version (the refetch after any write brings it in) is
  // adopted — its text shown, its `updatedAt` sent next — when it changes no
  // field the user has edited here: only properties, or text the page still
  // shows unedited. Otherwise it is not adopted; the next save is refused and
  // Reload shows it, never overwriting either side. The description is read
  // through `flush()`, so keystrokes still in the editor's debounce count.
  const issueUpdatedAt = new Date(issue.updatedAt).toISOString();
  React.useEffect(() => {
    const base = baseRef.current;
    if (conflictRef.current || issueUpdatedAt <= base.updatedAt) return;
    const currentDescription = descriptionRef.current?.flush() ?? description;
    const titleFree = issue.title === base.title || title === base.title;
    const descriptionFree =
      issue.description === base.description ||
      currentDescription === base.description;
    if (!titleFree || !descriptionFree) return;
    if (issue.title !== base.title) setTitle(issue.title);
    if (issue.description !== base.description) {
      setDescription(issue.description);
    }
    baseRef.current = {
      title: issue.title,
      description: issue.description,
      updatedAt: issueUpdatedAt,
    };
  }, [issue.title, issue.description, issueUpdatedAt, title, description]);

  function saveText(field: TextField, raw: string) {
    if (!canEdit) return;
    const value = field === "title" ? raw.trim() : raw;
    if (field === "title" && !value) {
      // A title is required: an emptied one goes back to the saved one.
      setTitle(baseRef.current.title);
      return;
    }
    void enqueue(async () => {
      const base = baseRef.current;
      if (conflictRef.current || value === base[field]) return;
      markSave(field, "saving");
      const expectedUpdatedAt = base.updatedAt;
      const result = await updateIssue(
        issue.id,
        field === "title"
          ? { title: value, expectedUpdatedAt }
          : { description: value, expectedUpdatedAt }
      );
      if (result.success) {
        baseRef.current = baseOf(result.data);
        markSave(field, "saved");
        return;
      }
      if (result.code === "issueChanged") {
        conflictRef.current = true;
        setConflict(true);
        markSave(field, "idle");
        return;
      }
      markSave(field, "error");
    });
  }

  function onTitleChange(value: string) {
    setTitle(value);
    if (saveState.title !== "saving") markSave("title", "idle");
  }

  function onDescriptionChange(value: string) {
    setDescription(value);
    if (saveState.description !== "saving") markSave("description", "idle");
  }

  async function reload() {
    setReloading(true);
    const fresh = await onReload().catch(() => null);
    setReloading(false);
    if (!fresh) {
      toast.error(t("reloadFailed"));
      return;
    }
    // Keep what the user changed and the server never got.
    const base = baseRef.current;
    const mine: Partial<Record<TextField, string>> = {};
    if (title.trim() !== base.title && title.trim() !== fresh.title) {
      mine.title = title;
    }
    if (description !== base.description && description !== fresh.description) {
      mine.description = description;
    }
    baseRef.current = baseOf(fresh);
    conflictRef.current = false;
    setConflict(false);
    setTitle(fresh.title);
    setDescription(fresh.description);
    setSaveState({ title: "idle", description: "idle" });
    setKept(Object.keys(mine).length > 0 ? mine : null);
    setFocusAfterReload(true);
  }

  // After Reload: to the kept text when there is some (the user copies from
  // there), else to the title; the Reload button itself is gone.
  React.useEffect(() => {
    if (!focusAfterReload) return;
    setFocusAfterReload(false);
    const keptBox = keptRef.current?.querySelector("textarea");
    (keptBox ?? titleRef.current)?.focus();
  }, [focusAfterReload]);

  // --- Properties ------------------------------------------------------------
  function patch(data: IssuePatch) {
    void enqueue(async () => {
      const result = await updateIssue(issue.id, data);
      if (!result.success) {
        toast.error(t("saveFailed"));
        return;
      }
      // The write bumped `updatedAt`. Adopt it only when the row's text is the
      // one ours is based on (else someone changed it meanwhile — see above).
      const base = baseRef.current;
      if (
        result.data.title === base.title &&
        result.data.description === base.description
      ) {
        baseRef.current = baseOf(result.data);
      }
      if (data.status) toast.success(tIssues("statusUpdated"));
    });
  }

  // Shown at once, saved in the update queue (in order with every other
  // write); when the last waiting toggle is done the page shows the set the
  // server confirmed.
  function onLabelsChange(ids: string[]) {
    setLabelIds(ids);
    pendingLabelsRef.current += 1;
    void enqueue(async () => {
      try {
        const result = await setIssueLabels(issue.id, ids);
        if (result.success) serverLabelsRef.current = ids;
        else toast.error(t("saveFailed"));
      } finally {
        pendingLabelsRef.current -= 1;
        if (pendingLabelsRef.current === 0) {
          setLabelIds(serverLabelsRef.current);
        }
      }
    });
  }

  // A parent can't be self (already excluded server-side) or one of this issue's
  // own children — that would make a cycle.
  const childIds = new Set(issue.children.map((c) => c.id));
  const parentCandidates = siblings.filter((s) => !childIds.has(s.id));
  const projectKey = issue.project.key;

  const properties = {
    issue,
    readOnly: !canEdit,
    users,
    environments,
    parentCandidates,
    allLabels,
    labelIds,
    onPatch: patch,
    onLabelsChange,
  };

  // --- Attachments, test runs, comments -------------------------------------
  async function onRecordTest(passed: boolean) {
    setRecording(true);
    const result = await recordTestRun({
      issueId: issue.id,
      passed,
      note: testNote.trim() || undefined,
    });
    setRecording(false);
    if (!result.success) {
      toast.error(
        result.message === "no_environment"
          ? t("testNeedsEnv")
          : t("testRecordFailed")
      );
      return;
    }
    setTestNote("");
    toast.success(t("testRecorded"));
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so re-picking the same file re-fires onChange
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/issues/${issue.id}/attachments`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(
          body.error === "too_large"
            ? t("attachmentTooLarge")
            : t("attachmentFailed")
        );
        return;
      }
      toast.success(t("attachmentAdded"));
      // A raw upload, outside the API client's refetch.
      router.refresh({ includeRemote: true });
    } catch {
      toast.error(t("attachmentFailed"));
    } finally {
      setUploading(false);
    }
  }

  async function onDeleteAttachment(id: string) {
    const result = await deleteIssueAttachment(id);
    if (!result.success) toast.error(t("saveFailed"));
  }

  async function postComment() {
    const body = comment.trim();
    if (!body) return;
    setPosting(true);
    const result = await addComment(issue.id, body);
    setPosting(false);
    if (!result.success) {
      toast.error(t("commentFailed"));
      return;
    }
    setComment("");
    toast.success(t("commentAdded"));
  }

  return (
    <div
      data-slot="issue-layout"
      className="grid w-full max-w-6xl grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]"
    >
      <div
        data-slot="issue-main"
        className="flex min-w-0 max-w-3xl flex-col gap-6"
      >
        {conflict ? (
          <Alert>
            <TriangleAlert />
            <AlertTitle>{t("conflictTitle")}</AlertTitle>
            <AlertDescription>
              <p>{t("conflictBody")}</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-1"
                disabled={reloading}
                onClick={reload}
              >
                <RotateCw data-icon="inline-start" />
                {t("conflictReload")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {kept ? (
          <div
            ref={keptRef}
            data-slot="kept-text"
            className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3"
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{t("keptTitle")}</span>
              <span className="text-sm text-muted-foreground">
                {t("keptBody")}
              </span>
            </div>
            {(["title", "description"] as const).map((field) =>
              kept[field] === undefined ? null : (
                <KeptText
                  key={field}
                  label={
                    field === "title" ? tIssues("titleLabel") : t("description")
                  }
                  value={kept[field]}
                />
              )
            )}
            <div>
              <Button size="sm" variant="ghost" onClick={() => setKept(null)}>
                {t("keptDismiss")}
              </Button>
            </div>
          </div>
        ) : null}

        {/* Title */}
        <div className="flex flex-col gap-1">
          {canEdit ? (
            <input
              ref={titleRef}
              aria-label={tIssues("titleLabel")}
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              onBlur={(e) => saveText("title", e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
              placeholder={t("titlePlaceholder")}
              maxLength={300}
              className="w-full rounded-sm bg-transparent text-xl font-semibold outline-none placeholder:text-muted-foreground/70 focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          ) : (
            <h2 className="text-xl font-semibold break-words">{issue.title}</h2>
          )}
          {canEdit ? (
            <SaveStatus
              field="title"
              state={saveState.title}
              onRetry={() => saveText("title", title)}
            />
          ) : null}
        </div>

        <IssuePropertyChips {...properties} />
        <IssueDatesLine issue={issue} />

        {/* Description */}
        <div className="flex flex-col gap-1">
          {canEdit ? (
            <>
              <MarkdownEditor
                ref={descriptionRef}
                borderless
                value={description}
                onChange={onDescriptionChange}
                onBlur={(markdown) => saveText("description", markdown)}
                linkableDocs={linkableDocs}
                contentClassName="min-h-[8rem]"
              />
              <SaveStatus
                field="description"
                state={saveState.description}
                onRetry={() => saveText("description", description)}
              />
            </>
          ) : issue.description.trim() ? (
            <MarkdownContent content={issue.description} className="text-sm" />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("noDescription")}
            </p>
          )}
        </div>

        {/* Subtasks */}
        {issue.children.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">
              {t("subtasks")}
              <span className="ms-1.5 text-muted-foreground">
                {issue.children.length}
              </span>
            </span>
            <ul className="flex flex-col gap-1">
              {issue.children.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/${projectKey}/issues/${c.number}`}
                    className="flex items-center gap-2 rounded-md border p-2 hover:bg-muted/50"
                  >
                    <TypeIcon type={c.type as IssueType} />
                    <span className="font-mono text-sm text-muted-foreground">
                      {projectKey}-{c.number}
                    </span>
                    <span className="flex-1 truncate text-sm">{c.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {tIssues(`status.${c.status}`)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Attachments */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">
              {t("attachments")}
              <span className="ms-1.5 text-muted-foreground">
                {attachments.length}
              </span>
            </span>
            {canEdit ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip className="size-4" />
                  {uploading ? t("attachmentUploading") : t("attachmentAdd")}
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={onUpload}
                />
              </>
            ) : null}
          </div>
          {attachments.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {attachments.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-2 rounded-md border p-2"
                >
                  <Paperclip className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate text-sm">{a.filename}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatBytes(a.sizeBytes)}
                  </span>
                  <a
                    href={`/api/issues/attachments/${a.id}`}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={t("attachmentDownload")}
                  >
                    <Download className="size-4" />
                  </a>
                  {canEdit ? (
                    <TooltipHint label={t("attachmentDelete")}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={t("attachmentDelete")}
                        onClick={() => onDeleteAttachment(a.id)}
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </TooltipHint>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {/* Test runs */}
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">
            {t("testRuns")}
            <span className="ms-1.5 text-muted-foreground">
              {testRuns.length}
            </span>
          </span>
          {!canEdit ? null : issue.environmentId ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3">
              <Input
                value={testNote}
                onChange={(e) => setTestNote(e.target.value)}
                placeholder={t("testNotePlaceholder")}
                className="min-w-52 flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={recording}
                className="gap-1.5"
                onClick={() => onRecordTest(true)}
              >
                <CircleCheck className="size-4 text-success" />
                {t("testPass")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={recording}
                className="gap-1.5"
                onClick={() => onRecordTest(false)}
              >
                <CircleX className="size-4 text-destructive" />
                {t("testFail")}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("testNeedsEnv")}</p>
          )}
          {testRuns.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {testRuns.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-2 rounded-md border p-2"
                >
                  {r.status === "success" ? (
                    <CircleCheck className="size-4 shrink-0 text-success" />
                  ) : (
                    <CircleX className="size-4 shrink-0 text-destructive" />
                  )}
                  <span className="flex-1 truncate text-sm">
                    {r.description}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    <RelativeTime date={r.runAt} />
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {/* Comments */}
        <div className="flex flex-col gap-3">
          <span className="text-sm font-medium">
            {t("comments")}
            <span className="ms-1.5 text-muted-foreground">
              {issue.comments.length}
            </span>
          </span>

          {issue.comments.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noComments")}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {issue.comments.map((c) => (
                <li key={c.id} className="flex gap-3">
                  {c.author ? (
                    <UserAvatar
                      user={c.author}
                      size="md"
                      className="mt-0.5 shrink-0"
                    />
                  ) : (
                    <span className="mt-0.5 size-7 shrink-0 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">
                      ?
                    </span>
                  )}
                  <div className="flex-1 min-w-0 rounded-lg border bg-card p-3">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                      <UserName
                        user={c.author}
                        className="font-medium text-foreground"
                      />
                      <span>
                        <RelativeTime date={c.createdAt} />
                      </span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap break-words">
                      {c.body}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {canEdit ? (
            <div className="flex flex-col gap-2">
              <MentionTextarea
                value={comment}
                onChange={setComment}
                users={users}
                placeholder={t("commentPlaceholder")}
                rows={3}
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  onClick={postComment}
                  disabled={posting || !comment.trim()}
                >
                  {posting ? t("posting") : t("post")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <IssuePropertiesSidebar {...properties} />
    </div>
  );
}

/** Inline save feedback under a field; announced politely. */
function SaveStatus({
  field,
  state,
  onRetry,
}: {
  field: TextField;
  state: SaveState;
  onRetry: () => void;
}) {
  const t = useTranslations("issueDetail");
  return (
    <div
      data-slot="save-status"
      data-field={field}
      role="status"
      className="flex min-h-5 items-center gap-2 text-xs text-muted-foreground"
    >
      {state === "saving" ? t("saving") : null}
      {state === "saved" ? t("saved") : null}
      {state === "error" ? (
        <>
          <span className="text-destructive">{t("saveNotSaved")}</span>
          <Button size="xs" variant="outline" onClick={onRetry}>
            {t("saveRetry")}
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** The user's replaced text, read-only, with a copy button. */
function KeptText({ label, value }: { label: string; value: string }) {
  const t = useTranslations("issueDetail");
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <CopyButton value={value} label={t("keptCopy", { field: label })} />
      </div>
      <Textarea
        readOnly
        aria-label={label}
        value={value}
        className="max-h-60 font-mono text-xs md:text-xs"
      />
    </div>
  );
}
