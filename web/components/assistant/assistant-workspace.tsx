import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Bot, MessagesSquare } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import type { AttachmentRef } from "@/lib/assistant/attachment-refs";
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

/**
 * The environment's Assistant tab: the caller's conversations, the open
 * thread with its question box, and the drafts of that conversation. A new
 * conversation is created by its first question.
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
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState
          icon={Bot}
          title={t("notEnabledTitle")}
          description={tErrors("notConfigured")}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {header}
      <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,1fr)_24rem]">
        <ConversationList
          environmentId={environmentId}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onNew={() => setSelectedId(null)}
        />
        <div className="flex min-w-0 flex-col gap-4">
          {selectedId ? (
            <ChatThread conversationId={selectedId} />
          ) : (
            <EmptyState
              icon={MessagesSquare}
              title={t("emptyThreadTitle")}
              description={t("emptyThreadDescription")}
            />
          )}
          <Composer
            environmentId={environmentId}
            disabled={busy || capped}
            onSend={send}
          />
        </div>
        {selectedId && (
          <div className="lg:col-start-2 xl:col-start-auto">
            <DraftPanel
              conversationId={selectedId}
              projectKey={projectKey}
              canCreateIssue={canCreateIssue}
              disabled={busy || capped}
            />
          </div>
        )}
      </div>
    </div>
  );
}
