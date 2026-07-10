"use client";

import { formatDistanceToNow } from "date-fns";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import type { IssueDetail } from "@/actions/issues";
import { addComment, updateIssue } from "@/actions/issues";
import {
  type AssignableUser,
  AssigneeSelect,
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
import { Textarea } from "@/components/ui/textarea";
import { useRouter } from "@/i18n/navigation";
import { getDateFnsLocale } from "@/lib/date-fns-locale";

type EnvOption = { id: string; name: string };
const NONE = "none";

export function IssueDetailClient({
  issue,
  users,
  environments,
}: {
  issue: IssueDetail;
  users: AssignableUser[];
  environments: EnvOption[];
}) {
  const t = useTranslations("issueDetail");
  const tIssues = useTranslations("issues");
  const locale = useLocale();
  const dfl = getDateFnsLocale(locale);
  const router = useRouter();

  const [title, setTitle] = React.useState(issue.title);
  const [description, setDescription] = React.useState(issue.description);
  const [comment, setComment] = React.useState("");
  const [posting, setPosting] = React.useState(false);

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
        <Field label={tIssues("columnStatus")}>
          <StatusSelect
            value={issue.status as Status}
            onChange={(s) => patch({ status: s }, tIssues("statusUpdated"))}
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
      </div>

      {/* Description */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t("description")}</span>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t("descriptionPlaceholder")}
          rows={5}
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
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
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
