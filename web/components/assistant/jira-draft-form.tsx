import { ExternalLink } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { SearchSelect } from "@/components/search-select";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/i18n/navigation";
import type { JiraDraft } from "@/lib/assistant/drafts";
import {
  type ConversationDraft,
  createJiraIssue,
  type DraftProjectOption,
  saveDraft,
} from "@/web/api/assistant";
import { ApiError } from "@/web/api/client";
import { useAssistantErrorText } from "./error-text";

// The Jira issue types a draft may use (lib/assistant/drafts.ts); Jira's own
// names, so not translated.
const ISSUE_TYPES = ["Story", "Task", "Bug"] as const;

type Form = {
  summary: string;
  issueType: JiraDraft["issueType"];
  description: string;
  /** One acceptance criterion per line. */
  criteria: string;
};

function toForm(content: Record<string, unknown>): Form {
  const issueType = ISSUE_TYPES.find((t) => t === content.issueType) ?? "Task";
  const criteria = Array.isArray(content.acceptanceCriteria)
    ? content.acceptanceCriteria.filter((c) => typeof c === "string")
    : [];
  return {
    summary: typeof content.summary === "string" ? content.summary : "",
    issueType,
    description:
      typeof content.description === "string" ? content.description : "",
    criteria: criteria.join("\n"),
  };
}

function toContent(form: Form): JiraDraft {
  return {
    summary: form.summary.trim(),
    issueType: form.issueType,
    description: form.description,
    acceptanceCriteria: form.criteria
      .split("\n")
      .map((c) => c.trim())
      .filter(Boolean),
  };
}

/**
 * A Jira draft, editable until it became an issue, including the project
 * its issue is filed in (required; preselected by the server). "Create Jira
 * ticket" is only offered for the saved draft (no unsaved edits, the project
 * included), with the chosen project's Jira write-back on and issue:write on
 * it, and asks for confirmation first: no ticket reaches Jira without the
 * user's review.
 */
export function JiraDraftForm({
  draft,
  projects,
}: {
  draft: ConversationDraft;
  /** The projects the caller sees (`/draft-projects`); undefined: loading. */
  projects: readonly DraftProjectOption[] | undefined;
}) {
  const t = useTranslations("assistant");
  const tCommon = useTranslations("common");
  const { errorText } = useAssistantErrorText();
  const saved = React.useMemo(() => toForm(draft.content), [draft.content]);
  const [form, setForm] = React.useState<Form>(saved);
  const [projectId, setProjectId] = React.useState<string | null>(
    draft.projectId
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [forbidden, setForbidden] = React.useState(false);

  const created = draft.issueId !== null;
  const project = projects?.find((p) => p.id === projectId) ?? null;
  const savedProject = projects?.find((p) => p.id === draft.projectId) ?? null;
  const dirty =
    projectId !== draft.projectId ||
    JSON.stringify(toContent(form)) !== JSON.stringify(toContent(saved));
  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveDraft({
        draftId: draft.id,
        content: toContent(form),
        ...(projectId ? { projectId } : {}),
      });
      toast.success(t("draftSaved"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { jiraKey } = await createJiraIssue(draft.id);
      setConfirmOpen(false);
      toast.success(t("jiraCreated", { jiraKey }));
    } catch (e) {
      setConfirmOpen(false);
      // No issue:write after all: the hint under the button says so.
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // Each project has its own Jira link and issue right: the hint follows
  // the project picked, saved or not.
  const blockedHint = !project
    ? t("draftProjectRequired")
    : !project.jiraPushEnabled
      ? t("jiraPushOff")
      : !project.canCreateIssue || forbidden
        ? t("noIssueWrite")
        : dirty
          ? t("saveBeforeCreate")
          : null;

  const id = (field: string) => `draft-${draft.id}-${field}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id("project")}>{t("draftProject")}</Label>
        <SearchSelect
          id={id("project")}
          value={projectId}
          onChange={(value) => {
            setProjectId(value);
            // Another project, another issue right: ask the server again.
            setForbidden(false);
          }}
          options={(projects ?? []).map((p) => ({
            value: p.id,
            label: p.name,
            hint: p.key,
          }))}
          placeholder={t("draftProjectPlaceholder")}
          invalid={!created && projects !== undefined && !project}
          disabled={created || projects === undefined}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id("summary")}>{t("fieldSummary")}</Label>
        <Input
          id={id("summary")}
          value={form.summary}
          onChange={(e) => set("summary", e.target.value)}
          maxLength={255}
          disabled={created}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id("type")}>{t("fieldIssueType")}</Label>
        <Select
          value={form.issueType}
          onValueChange={(v) => v && set("issueType", v)}
          disabled={created}
        >
          <SelectTrigger id={id("type")} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ISSUE_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id("description")}>{t("fieldDescription")}</Label>
        <Textarea
          id={id("description")}
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          rows={8}
          maxLength={32_000}
          disabled={created}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id("criteria")}>{t("fieldCriteria")}</Label>
        <Textarea
          id={id("criteria")}
          value={form.criteria}
          onChange={(e) => set("criteria", e.target.value)}
          rows={5}
          disabled={created}
        />
        <p className="text-xs text-muted-foreground">{t("criteriaHint")}</p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {created ? (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          {t("jiraCreatedAs", { jiraKey: draft.jiraKey ?? "—" })}
          {draft.issueNumber !== null && savedProject && (
            <Link
              href={`/${savedProject.key}/issues/${draft.issueNumber}`}
              className="inline-flex items-center gap-1 text-primary underline underline-offset-4"
            >
              {t("openPanelIssue")}
              <ExternalLink className="size-3.5" />
            </Link>
          )}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={save}
              disabled={!dirty || busy}
            >
              {t("saveDraft")}
            </Button>
            <Button
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={blockedHint !== null || busy}
            >
              {t("createJira")}
            </Button>
          </div>
          {blockedHint && (
            <p className="text-xs text-muted-foreground">{blockedHint}</p>
          )}
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("confirmCreateTitle")}</DialogTitle>
            <DialogDescription>
              {t("confirmCreateDescription")}
            </DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t("draftProject")}</dt>
            <dd className="break-words">{savedProject?.name}</dd>
            <dt className="text-muted-foreground">{t("fieldSummary")}</dt>
            <dd className="break-words">{saved.summary}</dd>
            <dt className="text-muted-foreground">{t("fieldIssueType")}</dt>
            <dd>{saved.issueType}</dd>
          </dl>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={busy}
            >
              {tCommon("cancel")}
            </Button>
            <Button onClick={create} disabled={busy}>
              {t("confirmCreate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
