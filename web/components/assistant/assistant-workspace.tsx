import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  Bot,
  ChevronDown,
  FilePlus2,
  FileText,
  MessagesSquare,
  Ticket,
} from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import type { AttachmentRef } from "@/lib/assistant/attachment-refs";
import { cn } from "@/lib/utils";
import {
  type Conversation,
  createConversation,
  getAllowanceQuery,
  getConversationQuery,
  sendMessage,
} from "@/web/api/assistant";
import { ApiError } from "@/web/api/client";
import { AllowanceBadge, capReached } from "./allowance-badge";
import { ChatThread, pendingAnswer } from "./chat-thread";
import { Composer } from "./composer";
import { ConversationList } from "./conversation-list";
import {
  canDraftFrom,
  type DraftKind,
  DraftPanel,
  useDraftGeneration,
} from "./draft-panel";
import { SourceChip, useSourceEnvironments } from "./source-chip";

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
 * The environment of the conversation's last question, null for any other
 * context (a deleted environment included), undefined without a question.
 */
function lastSourceOf(conversation: Conversation): string | null | undefined {
  const last = conversation.messages.findLast((m) => m.role === "user");
  if (!last) return undefined;
  return last.context?.kind === "environment"
    ? last.context.environmentId
    : null;
}

/**
 * The Assistant: the caller's conversations about the project, the open
 * thread with its question box, and, on demand, the drafts of that
 * conversation. Each question asks about the source in the composer's chip:
 * the project branches (null) or one of its environments. The chip starts at
 * `initialEnvironmentId`, and an opened conversation moves it to the source of
 * its last question. It fills the height its route gives it: the conversation
 * list and the thread scroll on their own while the question box stays at the
 * bottom. A new conversation is created by its first question.
 */
export function AssistantWorkspace({
  projectId,
  projectName,
  projectKey,
  canCreateIssue,
  initialEnvironmentId = null,
  conversationId = null,
  onConversationChange,
}: {
  projectId: string;
  projectName: string;
  projectKey: string;
  canCreateIssue: boolean;
  /** The chip's first value (an environment of this project), e.g. `?env=`. */
  initialEnvironmentId?: string | null;
  /** The open conversation, e.g. `?c=`; a change from outside opens it. */
  conversationId?: string | null;
  /** Called with the conversation the user opens, or null for a new one. */
  onConversationChange?: (id: string | null) => void;
}) {
  const t = useTranslations("assistant");
  const tErrors = useTranslations("assistantErrors");
  const allowance = useSuspenseQuery(getAllowanceQuery()).data;
  const [selectedId, setSelectedIdState] = React.useState(conversationId);
  // A new `conversationId` from the URL opens that conversation.
  const [seenProp, setSeenProp] = React.useState(conversationId);
  // The chip. `seededFor` is the conversation whose last question set it, so
  // opening a conversation moves the chip once and the user's pick then
  // stands. A ?env preselection counts as seeding the opened conversation.
  const [source, setSource] = React.useState<string | null>(
    initialEnvironmentId
  );
  const [seededFor, setSeededFor] = React.useState<string | null>(
    initialEnvironmentId ? conversationId : null
  );
  // A new `initialEnvironmentId` (an old environment link followed while
  // here) moves the chip; dropping it from the URL does not.
  const [seenEnv, setSeenEnv] = React.useState(initialEnvironmentId);
  if (initialEnvironmentId !== seenEnv) {
    setSeenEnv(initialEnvironmentId);
    if (initialEnvironmentId) setSource(initialEnvironmentId);
  }
  if (conversationId !== seenProp) {
    setSeenProp(conversationId);
    if (conversationId !== selectedId) {
      setSelectedIdState(conversationId);
      setSeededFor(null);
    }
  }
  const select = (id: string | null) => {
    if (id !== selectedId) setSeededFor(null);
    setSelectedIdState(id);
    onConversationChange?.(id);
  };
  const conversationQuery = useQuery({
    ...getConversationQuery(selectedId ?? ""),
    enabled: selectedId !== null,
  });
  // A link (`?c=`) to a conversation that is gone (or someone else's) opens
  // nothing: the selection is cleared and the URL with it.
  const foreign =
    selectedId !== null &&
    conversationQuery.error instanceof ApiError &&
    conversationQuery.error.status === 404;
  const conversation = foreign ? undefined : conversationQuery.data;
  const dropForeign = React.useEffectEvent(() => select(null));
  React.useEffect(() => {
    if (foreign) dropForeign();
  }, [foreign]);

  if (
    conversation &&
    conversation.id === selectedId &&
    seededFor !== selectedId
  ) {
    const last = lastSourceOf(conversation);
    setSeededFor(selectedId);
    if (last !== undefined) setSource(last);
  }
  // A preselected id this project does not have (or no longer has) is the
  // project branches.
  const sources = useSourceEnvironments(projectId);
  const environmentId =
    source &&
    sources.loaded &&
    !sources.environments.some((e) => e.id === source)
      ? null
      : source;

  const isLarge = useIsLarge();
  const [draftsOpen, setDraftsOpen] = React.useState(false);
  const draftCount = conversation?.drafts.length ?? 0;
  const drafts = useDraftGeneration(selectedId ?? "");

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
    let id = selectedId;
    if (!id) {
      id = (await createConversation()).id;
      select(id);
      // Its first question is still being sent: the chip holds its source.
      setSeededFor(id);
    }
    await sendMessage({
      conversationId: id,
      text,
      context: environmentId
        ? { kind: "environment", environmentId }
        : { kind: "project", projectId },
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  };

  const newDraft = (kind: DraftKind) => {
    setDraftsOpen(true);
    drafts.generate(kind);
  };

  const header = (
    <PageHeader
      title={t("title")}
      subtitle={t("subtitle", { name: projectName })}
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

  const draftPanel = selectedId && !foreign && (
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
            selectedId={selectedId}
            onSelect={select}
            onNew={() => {
              select(null);
              setSource(null);
            }}
          />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
          {selectedId && !foreign ? (
            <>
              <div className="flex shrink-0 justify-end gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          busy ||
                          capped ||
                          !canDraftFrom(conversation) ||
                          drafts.generating !== null
                        }
                      />
                    }
                  >
                    <FilePlus2 data-icon="inline-start" />
                    {t("newDraft")}
                    <ChevronDown data-icon="inline-end" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => newDraft("brd")}>
                      <FileText />
                      {t("newDraftBrd")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => newDraft("jira")}>
                      <Ticket />
                      {t("newDraftIssue")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
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
              <ChatThread
                key={selectedId}
                conversationId={selectedId}
                projectName={projectName}
              />
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
              projectId={projectId}
              disabled={busy || capped}
              capResetsAt={capped ? allowance.resetsAt : null}
              onSend={send}
              focusKey={selectedId ?? "new"}
              source={
                <SourceChip
                  projectId={projectId}
                  value={environmentId}
                  onChange={setSource}
                  disabled={busy || capped}
                />
              }
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
                aria-label={t("draftsTitle")}
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
