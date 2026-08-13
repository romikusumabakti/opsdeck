"use client";

import { formatDistanceToNow } from "date-fns";
import {
  CircleCheck,
  CircleX,
  Download,
  Paperclip,
  Trash2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import {
  deleteIssueAttachment,
  type IssueAttachmentRow,
} from "@/actions/issue-attachments";
import type { IssueDetail } from "@/actions/issues";
import { addComment, updateIssue } from "@/actions/issues";
import { setIssueLabels } from "@/actions/labels";
import { recordTestRun, type TestRunRow } from "@/actions/test-runs";
import {
  type AssignableUser,
  AssigneeSelect,
  type IssueType,
  type MilestoneOption,
  MilestoneSelect,
  type Priority,
  PrioritySelect,
  type Status,
  StatusSelect,
  TypeIcon,
  TypeSelect,
} from "@/components/issues-board";
import { LabelChips, LabelPicker } from "@/components/label-ui";
import { MarkdownEditor } from "@/components/markdown-editor";
import { MentionTextarea } from "@/components/mention-textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Link, useRouter } from "@/i18n/navigation";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import { formatBytes } from "@/lib/utils";

type EnvOption = { id: string; name: string };
const NONE = "none";

export function IssueDetailClient({
  issue,
  users,
  environments,
  milestones,
  siblings,
  attachments,
  testRuns,
  allLabels,
}: {
  issue: IssueDetail;
  users: AssignableUser[];
  environments: EnvOption[];
  milestones: MilestoneOption[];
  siblings: { id: string; number: number; title: string }[];
  attachments: IssueAttachmentRow[];
  testRuns: TestRunRow[];
  allLabels: { id: string; name: string; color: string; createdAt: Date }[];
}) {
  const t = useTranslations("issueDetail");
  const tIssues = useTranslations("issues");
  const locale = useLocale();
  const dfl = getDateFnsLocale(locale);
  const router = useRouter();

  const [title, setTitle] = React.useState(issue.title);
  const [description, setDescription] = React.useState(issue.description);
  const [labelIds, setLabelIds] = React.useState(issue.labels.map((l) => l.id));
  const [comment, setComment] = React.useState("");
  const [posting, setPosting] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [testNote, setTestNote] = React.useState("");
  const [recording, setRecording] = React.useState(false);

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
    router.refresh();
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
      router.refresh();
    } catch {
      toast.error(t("attachmentFailed"));
    } finally {
      setUploading(false);
    }
  }

  async function onDeleteAttachment(id: string) {
    const result = await deleteIssueAttachment(id);
    if (!result.success) toast.error(t("saveFailed"));
    else router.refresh();
  }

  async function onLabelsChange(ids: string[]) {
    setLabelIds(ids);
    await setIssueLabels(issue.id, ids);
    router.refresh();
  }

  const selectedLabels = allLabels.filter((l) => labelIds.includes(l.id));

  // A parent can't be self (already excluded server-side) or one of this issue's
  // own children — that would make a cycle.
  const childIds = new Set(issue.children.map((c) => c.id));
  const parentCandidates = siblings.filter((s) => !childIds.has(s.id));
  const projectKey = issue.project.key;

  async function patch(data: Record<string, unknown>, okMsg?: string) {
    const result = await updateIssue(issue.id, data);
    if (!result.success) {
      toast.error(t("saveFailed"));
    } else if (okMsg) {
      toast.success(okMsg);
    }
    router.refresh();
  }

  async function saveTitle() {
    const v = title.trim();
    if (!v || v === issue.title) return;
    await patch({ title: v }, t("saved"));
  }

  async function saveDescription() {
    if (description === issue.description) return;
    await patch({ description }, t("saved"));
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
    router.refresh();
  }

  const ago = (d: Date) =>
    formatDistanceToNow(new Date(d), { addSuffix: true, locale: dfl });

  return (
    <div className="flex flex-col gap-6 max-w-3xl w-full">
      {/* Title */}
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={saveTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        placeholder={t("titlePlaceholder")}
        className="text-lg font-semibold h-11"
      />

      {/* Meta controls */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field label={tIssues("typeLabel")}>
          <TypeSelect
            value={issue.type as IssueType}
            onChange={(ty) => patch({ type: ty })}
          />
        </Field>
        <Field label={tIssues("columnStatus")}>
          <StatusSelect
            value={issue.status as Status}
            onChange={(s) => patch({ status: s }, tIssues("statusUpdated"))}
          />
        </Field>
        <Field label={tIssues("priorityLabel")}>
          <PrioritySelect
            value={issue.priority as Priority}
            onChange={(p) => patch({ priority: p })}
          />
        </Field>
        <Field label={tIssues("assignee")}>
          <AssigneeSelect
            users={users}
            value={issue.assignee?.id ?? null}
            onChange={(a) => patch({ assigneeId: a })}
          />
        </Field>
        <Field label={tIssues("columnEnvironment")}>
          <Select
            value={issue.environment?.id ?? NONE}
            onValueChange={(v) =>
              patch({ environmentId: !v || v === NONE ? null : v })
            }
          >
            <SelectTrigger className="h-8 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{tIssues("none")}</SelectItem>
              {environments.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {milestones.length > 0 ? (
          <Field label={tIssues("milestone")}>
            <MilestoneSelect
              milestones={milestones}
              value={issue.milestoneId ?? null}
              onChange={(m) => patch({ milestoneId: m })}
            />
          </Field>
        ) : null}
        {parentCandidates.length > 0 || issue.parentId ? (
          <Field label={t("parent")}>
            <Select
              value={issue.parentId ?? NONE}
              onValueChange={(v) =>
                patch({ parentId: !v || v === NONE ? null : v })
              }
            >
              <SelectTrigger className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t("noParent")}</SelectItem>
                {parentCandidates.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {projectKey}-{s.number} · {s.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
      </div>

      {/* Labels */}
      <div className="flex flex-wrap items-center gap-2">
        <LabelPicker
          allLabels={allLabels}
          selected={labelIds}
          onChange={onLabelsChange}
        />
        {selectedLabels.length > 0 ? (
          <LabelChips labels={selectedLabels} />
        ) : (
          <span className="text-sm text-muted-foreground">{t("noLabels")}</span>
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
                  <span className="font-mono text-xs text-muted-foreground">
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
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t("attachmentDelete")}
                  onClick={() => onDeleteAttachment(a.id)}
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
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
        {issue.environmentId ? (
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
                <span className="flex-1 truncate text-sm">{r.description}</span>
                <span className="text-xs text-muted-foreground">
                  {ago(r.runAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* Description */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t("description")}</span>
        {/* Same markdown editor as the knowledge document form. The shorter
            min-height keeps the description from dominating the issue page. */}
        <MarkdownEditor
          value={description}
          onChange={setDescription}
          placeholder={t("descriptionPlaceholder")}
          contentClassName="min-h-[12rem]"
        />
        {description !== issue.description ? (
          <div className="flex gap-2">
            <Button size="sm" onClick={saveDescription}>
              {t("save")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDescription(issue.description)}
            >
              ×
            </Button>
          </div>
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
                <span className="mt-0.5 size-7 shrink-0 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold">
                  {(c.author?.name ?? "?").charAt(0).toUpperCase()}
                </span>
                <div className="flex-1 min-w-0 rounded-lg border bg-card p-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                    <span className="font-medium text-foreground">
                      {c.author?.name ?? t("unknownUser")}
                    </span>
                    <span>{ago(c.createdAt)}</span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap break-words">
                    {c.body}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}

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
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
