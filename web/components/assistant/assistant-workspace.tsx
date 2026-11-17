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
import { useModKey } from "@/hooks/use-is-mac";
import type { AttachmentRef } from "@/lib/assistant/attachment-refs";
import type { QuestionContextInput } from "@/lib/assistant/context";
import { cn } from "@/lib/utils";
import {
  type Conversation,
  createConversation,
  getAllowanceQuery,
  getConversationQuery,
  type MessageContext,
  sendMessage,
} from "@/web/api/assistant";
import { ApiError } from "@/web/api/client";
import { AllowanceBadge, capReached } from "./allowance-badge";
import { assistantShortcutLabel } from "./assistant-shortcut";
import { ChatThread, pendingAnswer } from "./chat-thread";
import { Composer } from "./composer";
import { useContextOptions, visibleContext } from "./context-picker";
import { ConversationList } from "./conversation-list";
import {
  canDraftFrom,
  type DraftKind,
  DraftPanel,
  useDraftGeneration,
} from "./draft-panel";

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

const AUTO: QuestionContextInput = { kind: "auto" };

/**
 * A stored question context as the chip's value: its environment, or, once
 * that environment is gone, its project; Automatic when neither is left.
 */
function pickOf(context: MessageContext | null): QuestionContextInput {
  if (context?.kind === "environment" && context.environmentId) {
    return { kind: "environment", environmentId: context.environmentId };
  }
  if (context?.kind !== "auto" && context?.projectId) {
    return { kind: "project", projectId: context.projectId };
  }
  return AUTO;
}

/**
 * The context of the conversation's last question, undefined without one.
 */
function lastContextOf(
  conversation: Conversation
): QuestionContextInput | undefined {
  const last = conversation.messages.findLast((m) => m.role === "user");
  return last && pickOf(last.context);
}

/** A stable key for a context (or none), to notice a new preselection. */
function keyOf(context: QuestionContextInput | null): string {
  if (!context) return "";
  if (context.kind === "project") return `p:${context.projectId}`;
  if (context.kind === "environment") return `e:${context.environmentId}`;
  return "auto";
}

/**
 * The Assistant: the caller's conversations, the open thread with its
 * question box, and, on demand, the drafts of that conversation. Each
 * question asks about the context in the composer's chip: Automatic, a
 * project, or an environment. The chip starts at `initialContext` (else
 * Automatic), and an opened conversation moves it to the context of its last
 * question; a project or environment the caller no longer sees reads as
 * Automatic. It fills the height its route gives it: the conversation list
 * and the thread scroll on their own while the question box stays at the
 * bottom. A new conversation is created by its first question.
 */
export function AssistantWorkspace({
  initialContext = null,
  conversationId = null,
  onConversationChange,
}: {
  /** The chip's first value, e.g. from `?project=` or `?env=`. */
  initialContext?: QuestionContextInput | null;
  /** The open conversation, e.g. `?c=`; a change from outside opens it. */
  conversationId?: string | null;
  /** Called with the conversation the user opens, or null for a new one. */
  onConversationChange?: (id: string | null) => void;
}) {
  const t = useTranslations("assistant");
  const tErrors = useTranslations("assistantErrors");
  const modKey = useModKey();
  const allowance = useSuspenseQuery(getAllowanceQuery()).data;
  const [selectedId, setSelectedIdState] = React.useState(conversationId);
  // A new `conversationId` from the URL opens that conversation.
  const [seenProp, setSeenProp] = React.useState(conversationId);
  // The chip. `seededFor` is the conversation whose last question set it, so
  // opening a conversation moves the chip once and the user's pick then
  // stands. A preselection counts as seeding the opened conversation.
  const [picked, setPicked] = React.useState<QuestionContextInput>(
    initialContext ?? AUTO
  );
  const [seededFor, setSeededFor] = React.useState<string | null>(
    initialContext ? conversationId : null
  );
  // A new `initialContext` (a link followed while here) moves the chip;
  // dropping it from the URL does not.
  const [seenInitial, setSeenInitial] = React.useState(keyOf(initialContext));
  if (keyOf(initialContext) !== seenInitial) {
    setSeenInitial(keyOf(initialContext));
    if (initialContext) setPicked(initialContext);
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
    const last = lastContextOf(conversation);
    setSeededFor(selectedId);
    if (last !== undefined) setPicked(last);
  }
  // A project or environment the caller does not (or no longer) see is
  // Automatic.
  const contextOptions = useContextOptions();
  const context = visibleContext(picked, contextOptions);

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

  // The conversation made for a first question whose send then failed: the
  // retry sends into it rather than leaving another empty one behind.
  const created = React.useRef<string | null>(null);

  const send = async (text: string, attachments: AttachmentRef[]) => {
    let id = selectedId;
    if (!id) {
      id = created.current ?? (await createConversation()).id;
      created.current = id;
    }
    await sendMessage({
      conversationId: id,
      text,
      context,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    if (id !== selectedId) {
      created.current = null;
      // Opened only once its first question is stored: a read racing the
      // send could come back empty, and nothing would read it again.
      select(id);
      // The chip keeps the context just sent.
      setSeededFor(id);
    }
  };

  const newDraft = (kind: DraftKind) => {
    setDraftsOpen(true);
    drafts.generate(kind);
  };

  const header = (
    <PageHeader
      title={t("title")}
      subtitle={t("subtitle")}
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
  // The assistant takes questions only from users who see a project.
  if (contextOptions.loaded && contextOptions.projects.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto">
        {header}
        <EmptyState
          icon={Bot}
          title={t("noProjectsTitle")}
          description={t("noProjectsDescription")}
        />
      </div>
    );
  }

  const draftPanel = selectedId && !foreign && (
    <DraftPanel
      conversationId={selectedId}
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
              setPicked(AUTO);
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
              <ChatThread key={selectedId} conversationId={selectedId} />
            </>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <EmptyState
                icon={MessagesSquare}
                title={t("emptyThreadTitle")}
                description={t("emptyThreadDescription")}
              />
              <p className="text-center text-xs text-muted-foreground">
                {t("shortcutHint", {
                  shortcut: assistantShortcutLabel(modKey),
                })}
              </p>
            </div>
          )}
          <div className="shrink-0">
            <Composer
              disabled={busy || capped}
              capResetsAt={capped ? allowance.resetsAt : null}
              onSend={send}
              focusKey={selectedId ?? "new"}
              context={context}
              onContextChange={setPicked}
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
