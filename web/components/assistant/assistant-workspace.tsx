import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Bot, FileText, MessagesSquare } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import type { AttachmentRef } from "@/lib/assistant/attachment-refs";
import { cn } from "@/lib/utils";
import {
  createConversation,
  getAllowanceQuery,
  getConversationQuery,
  sendMessage,
} from "@/web/api/assistant";
import { AllowanceBadge, capReached } from "./allowance-badge";
import { ChatThread, pendingAnswer } from "./chat-thread";
import { Composer } from "./composer";
import { ConversationList } from "./conversation-list";
import { DraftPanel } from "./draft-panel";

const LARGE = "(min-width: 64rem)"; // Tailwind `lg`

/** Whether the viewport is at least Tailwind's `lg` breakpoint. */
function useIsLarge() {
  return React.useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(LARGE);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(LARGE).matches
  );
}

/**
 * The environment's Assistant tab: the caller's conversations, the open
 * thread with its question box, and, on demand, the drafts of that
 * conversation. It fills the height its route gives it: the conversation
 * list and the thread scroll on their own while the question box stays at
 * the bottom. A new conversation is created by its first question.
 */
export function AssistantWorkspace({
  environmentId,
  environmentName,
  projectKey,
  canCreateIssue,
}: {
  environmentId: string;
  environmentName: string;
  projectKey: string;
  canCreateIssue: boolean;
}) {
  const t = useTranslations("assistant");
  const tErrors = useTranslations("assistantErrors");
  const allowance = useSuspenseQuery(getAllowanceQuery()).data;
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const conversation = useQuery({
    ...getConversationQuery(selectedId ?? ""),
    enabled: selectedId !== null,
  }).data;

  const isLarge = useIsLarge();
  const [draftsOpen, setDraftsOpen] = React.useState(false);
  const draftCount = conversation?.drafts.length ?? 0;

  // A new draft in the open conversation opens the panel. Adjusted during
  // render (not in an effect): switching conversations only resets the base.
  const [seenDrafts, setSeenDrafts] = React.useState<{
    id: string;
    count: number;
  } | null>(null);
  if (
    conversation &&
    selectedId &&
    (seenDrafts?.id !== selectedId || seenDrafts.count !== draftCount)
  ) {
    if (seenDrafts?.id === selectedId && draftCount > seenDrafts.count) {
      setDraftsOpen(true);
    }
    setSeenDrafts({ id: selectedId, count: draftCount });
  }

  const busy = pendingAnswer(conversation) !== null;
  const capped = capReached(allowance);

  const send = async (text: string, attachments: AttachmentRef[]) => {
    let conversationId = selectedId;
    if (!conversationId) {
      conversationId = (await createConversation(environmentId)).id;
      setSelectedId(conversationId);
    }
    await sendMessage({
      conversationId,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  };

  const header = (
    <PageHeader
      title={t("title")}
      subtitle={t("subtitle", { name: environmentName })}
      action={allowance.enabled && <AllowanceBadge allowance={allowance} />}
    />
  );

  if (!allowance.enabled) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto">
        {header}
        <EmptyState
          icon={Bot}
          title={t("notEnabledTitle")}
          description={tErrors("notConfigured")}
        />
      </div>
    );
  }

  const draftPanel = selectedId && (
    <DraftPanel
      conversationId={selectedId}
      projectKey={projectKey}
      canCreateIssue={canCreateIssue}
      disabled={busy || capped}
      onClose={() => setDraftsOpen(false)}
    />
  );

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-6">
      {header}
      <div
        className={cn(
          "flex min-h-0 flex-col gap-6 lg:grid lg:grid-cols-[14rem_minmax(0,1fr)]",
          draftsOpen && selectedId && "lg:grid-cols-[14rem_minmax(0,1fr)_24rem]"
        )}
      >
        <div className="flex max-h-40 min-h-0 shrink-0 flex-col lg:max-h-none">
          <ConversationList
            environmentId={environmentId}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onNew={() => setSelectedId(null)}
          />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
          {selectedId ? (
            <>
              <div className="flex shrink-0 justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  aria-expanded={draftsOpen}
                  onClick={() => setDraftsOpen((open) => !open)}
                >
                  <FileText data-icon="inline-start" />
                  {t("drafts", { count: draftCount })}
                </Button>
              </div>
              <ChatThread key={selectedId} conversationId={selectedId} />
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <EmptyState
                icon={MessagesSquare}
                title={t("emptyThreadTitle")}
                description={t("emptyThreadDescription")}
              />
            </div>
          )}
          <div className="shrink-0">
            <Composer
              environmentId={environmentId}
              disabled={busy || capped}
              onSend={send}
              focusKey={selectedId ?? "new"}
            />
          </div>
        </div>
        {draftPanel &&
          (isLarge ? (
            draftsOpen && (
              <aside className="min-h-0 overflow-y-auto">{draftPanel}</aside>
            )
          ) : (
            <Sheet open={draftsOpen} onOpenChange={setDraftsOpen}>
              <SheetContent
                side="right"
                showCloseButton={false}
                aria-label={t("drafts", { count: draftCount })}
                className="overflow-y-auto p-4"
              >
                {draftPanel}
              </SheetContent>
            </Sheet>
          ))}
      </div>
    </div>
  );
}
