import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { FileText, Loader2, Ticket, X } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  type Conversation,
  generateDraft,
  getAllowanceQuery,
  getConversationQuery,
} from "@/web/api/assistant";
import { BrdDraftForm } from "./brd-draft-form";
import { useAssistantErrorText } from "./error-text";
import { JiraDraftForm } from "./jira-draft-form";

export type DraftKind = "brd" | "jira";

/** A draft is written from answers: the conversation needs a finished one. */
export function canDraftFrom(conversation: Conversation | undefined): boolean {
  return (
    conversation?.messages.some(
      (m) => m.role === "assistant" && m.status === "done"
    ) ?? false
  );
}

const draftMutationKey = (conversationId: string) => [
  "assistant",
  "generateDraft",
  conversationId,
];

/**
 * Has the model write a draft of the conversation. One mutation key per
 * conversation, so the panel shows a generation started from elsewhere (the
 * thread header's "New draft" menu) as its own: which kind is being written,
 * and the last attempt's error.
 */
export function useDraftGeneration(conversationId: string) {
  const queryClient = useQueryClient();
  const mutationKey = draftMutationKey(conversationId);
  const { mutate } = useMutation({
    mutationKey,
    mutationFn: (kind: DraftKind) => generateDraft({ conversationId, kind }),
    // Also after a failure: a request cut off by a proxy timeout may still
    // have stored the draft server-side. The spend changed either way.
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: getConversationQuery(conversationId).queryKey,
      });
      void queryClient.invalidateQueries({
        queryKey: getAllowanceQuery().queryKey,
      });
    },
  });
  const latest = useMutationState({
    filters: { mutationKey, exact: true },
    select: (m) => ({
      status: m.state.status,
      kind: m.state.variables as DraftKind | undefined,
      error: m.state.error,
    }),
  }).at(-1);
  // Forgets finished attempts, so an old error is not shown again. A running
  // one stays: the panel opened by "New draft" shows it.
  const clearSettled = React.useCallback(() => {
    const cache = queryClient.getMutationCache();
    const mutationKey = draftMutationKey(conversationId);
    for (const m of cache.findAll({ mutationKey, exact: true })) {
      if (m.state.status !== "pending") cache.remove(m);
    }
  }, [queryClient, conversationId]);
  return {
    clearSettled,
    generate: (kind: DraftKind) => mutate(kind),
    generating: latest?.status === "pending" ? (latest.kind ?? null) : null,
    error: latest?.status === "error" ? latest.error : null,
  };
}

/**
 * Drafts written by the model from the conversation: a BRD section set or an
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
  const conversation = useQuery(getConversationQuery(conversationId)).data;
  const { generate, generating, error, clearSettled } =
    useDraftGeneration(conversationId);
  // Opening the panel (or another conversation's) starts without an old error.
  React.useEffect(() => clearSettled(), [clearSettled]);

  const drafts = [...(conversation?.drafts ?? [])].reverse();
  const title = t("draftsTitle");
  const hasAnswer = canDraftFrom(conversation);

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
      {error && <p className="text-sm text-destructive">{errorText(error)}</p>}
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
