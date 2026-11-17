import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Loader2, Ticket, X } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  generateDraft,
  getAllowanceQuery,
  getConversationQuery,
} from "@/web/api/assistant";
import { BrdDraftForm } from "./brd-draft-form";
import { useAssistantErrorText } from "./error-text";
import { JiraDraftForm } from "./jira-draft-form";

type DraftKind = "brd" | "jira";

/**
 * Drafts written by Claude from the conversation: a BRD section set or an
 * issue, newest first, each editable before anything leaves the Panel.
 */
export function DraftPanel({
  conversationId,
  projectKey,
  canCreateIssue,
  disabled,
  onClose,
}: {
  conversationId: string;
  projectKey: string;
  canCreateIssue: boolean;
  /** An answer is running or the day's cap is spent. */
  disabled: boolean;
  onClose?: () => void;
}) {
  const t = useTranslations("assistant");
  const { errorText } = useAssistantErrorText();
  const queryClient = useQueryClient();
  const conversation = useQuery(getConversationQuery(conversationId)).data;
  const [generating, setGenerating] = React.useState<DraftKind | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const generate = async (kind: DraftKind) => {
    setGenerating(kind);
    setError(null);
    try {
      await generateDraft({ conversationId, kind });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setGenerating(null);
      // Also after a failure: a request cut off by a proxy timeout may still
      // have stored the draft server-side. The spend changed either way.
      void queryClient.invalidateQueries({
        queryKey: getConversationQuery(conversationId).queryKey,
      });
      void queryClient.invalidateQueries({
        queryKey: getAllowanceQuery().queryKey,
      });
    }
  };

  const drafts = [...(conversation?.drafts ?? [])].reverse();
  const title = t("drafts", { count: drafts.length });
  const hasAnswer = conversation?.messages.some(
    (m) => m.role === "assistant" && m.status === "done"
  );

  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">{title}</h2>
          <p className="text-sm text-muted-foreground">{t("draftsHint")}</p>
        </div>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("closeDrafts")}
          >
            <X />
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {(["brd", "jira"] as const).map((kind) => (
          <Button
            key={kind}
            variant="outline"
            size="sm"
            onClick={() => generate(kind)}
            disabled={disabled || !hasAnswer || generating !== null}
          >
            {generating === kind ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : kind === "brd" ? (
              <FileText data-icon="inline-start" />
            ) : (
              <Ticket data-icon="inline-start" />
            )}
            {kind === "brd" ? t("draftBrd") : t("draftJira")}
          </Button>
        ))}
      </div>
      {generating && (
        <p className="text-sm text-muted-foreground">{t("generating")}</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {drafts.map((draft) => (
        <article
          key={draft.id}
          className="flex flex-col gap-3 rounded-lg border p-3"
        >
          <header className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">
              {draft.kind === "brd" ? t("draftBrd") : t("draftJira")}
            </h3>
            <RelativeTime
              date={draft.updatedAt}
              className="text-xs text-muted-foreground"
            />
          </header>
          {draft.kind === "jira" ? (
            <JiraDraftForm
              draft={draft}
              projectKey={projectKey}
              jiraPushEnabled={conversation?.jiraPushEnabled ?? false}
              canCreateIssue={canCreateIssue}
            />
          ) : (
            <BrdDraftForm draft={draft} />
          )}
        </article>
      ))}
    </section>
  );
}
