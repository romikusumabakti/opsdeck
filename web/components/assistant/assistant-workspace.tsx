import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  Bot,
  FileText,
  MessagesSquare,
  MoreHorizontal,
  Ticket,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { TooltipHint } from "@/components/ui/tooltip";
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
  retryAnswer,
  sendMessage,
  stopAnswer,
} from "@/web/api/assistant";
import { ApiError } from "@/web/api/client";
import { AllowanceBadge, capReached, showMeter } from "./allowance-badge";
import { assistantShortcutLabel } from "./assistant-shortcut";
import { ChatThread, pendingAnswer } from "./chat-thread";
import { Composer } from "./composer";
import {
  composerDrafts,
  type DraftKey,
  NEW_CHAT,
  useComposerDraft,
  useDraftUser,
} from "./composer-drafts";
import { useContextOptions, visibleContext } from "./context-picker";
import { ConversationList } from "./conversation-list";
import {
  canDraftFrom,
  type DraftKind,
  DraftPanel,
  useDraftGeneration,
} from "./draft-panel";
import { useAssistantErrorText } from "./error-text";

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
 * The Assistant: the caller's chats, the open thread with its question box,
 * and, on demand, the drafts of that chat. Each
 * question asks about the context in the composer's chip: Automatic, a
 * project, or an environment. The question box keeps an unsent draft per
 * chat (text, files, attachments and chip; New chat has its own), so
 * switching chats shows that chat's. A chat without a chip yet starts at the
 * context of its last question (New chat: Automatic); `initialContext` sets
 * the chip of the chat open when it arrives. A project or environment the
 * caller no longer sees reads as Automatic. It fills the height its route
 * gives it: the conversation list and the thread scroll on their own while
 * the question box stays at the bottom. A new conversation is created by its first question.
 */
export function AssistantWorkspace({
  initialContext = null,
  conversationId = null,
  onConversationChange,
}: {
  /** Sets the open chat's chip, e.g. from `?project=` or `?env=`. */
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
  // A preselection (at mount, or a link followed while here) waiting to be
  // written into the chip of the chat open when it came; dropping it from
  // the URL changes nothing.
  const [preselect, setPreselect] = React.useState<{
    key: DraftKey;
    context: QuestionContextInput;
  } | null>(
    initialContext
      ? { key: conversationId ?? NEW_CHAT, context: initialContext }
      : null
  );
  const [seenInitial, setSeenInitial] = React.useState(keyOf(initialContext));
  if (keyOf(initialContext) !== seenInitial) {
    setSeenInitial(keyOf(initialContext));
    if (initialContext) {
      // The chat open after this change: a link can close one and preselect
      // in the same step (?c=A to ?project=).
      const target = conversationId !== seenProp ? conversationId : selectedId;
      setPreselect({ key: target ?? NEW_CHAT, context: initialContext });
    }
  }
  if (conversationId !== seenProp) {
    setSeenProp(conversationId);
    if (conversationId !== selectedId) setSelectedIdState(conversationId);
  }
  const select = (id: string | null) => {
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
  const dropForeign = React.useEffectEvent(() => {
    // A preselection meant for that chat belongs to New chat now.
    setPreselect((p) => (p?.key === selectedId ? { ...p, key: NEW_CHAT } : p));
    select(null);
  });
  React.useEffect(() => {
    if (foreign) dropForeign();
  }, [foreign]);

  // The open chat's draft. Its chip, until set, is seeded: a chat's from its
  // last question once read, New chat's Automatic. A pending preselection
  // for this chat is shown until written.
  const userId = useDraftUser();
  const draftKey: DraftKey = selectedId ?? NEW_CHAT;
  const [draft] = useComposerDraft(userId, draftKey);
  const loaded = conversation !== undefined && conversation.id === selectedId;
  const seed =
    selectedId === null
      ? AUTO
      : loaded
        ? (lastContextOf(conversation) ?? AUTO)
        : undefined;
  // Store writes, so after render (and after `useDraftUser` made the user
  // the store's owner): a preselection replaces its chat's chip, a seed
  // fills an unset one.
  // One for a chat not read yet waits for it (it may turn out foreign).
  const waitingForChat =
    preselect !== null && preselect.key === selectedId && (foreign || !loaded);
  React.useEffect(() => {
    if (!userId || !preselect || waitingForChat) return;
    composerDrafts.update(preselect.key, (d) => ({
      ...d,
      context: preselect.context,
    }));
    setPreselect(null);
  }, [userId, preselect, waitingForChat]);
  React.useEffect(() => {
    if (!userId || seed === undefined || draft.context !== null) return;
    composerDrafts.update(draftKey, (d) =>
      d.context === null ? { ...d, context: seed } : d
    );
  }, [userId, draftKey, draft.context, seed]);
  // A project or environment the caller does not (or no longer) see is
  // Automatic.
  const contextOptions = useContextOptions();
  const context = visibleContext(
    (preselect?.key === draftKey ? preselect.context : draft.context) ??
      seed ??
      AUTO,
    contextOptions
  );

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
  const queryClient = useQueryClient();
  const { errorText } = useAssistantErrorText();
  // Stop is disabled from the click until its request settles.
  const [stopping, setStopping] = React.useState(false);
  const stop = async () => {
    if (!selectedId || stopping) return;
    setStopping(true);
    try {
      await stopAnswer(selectedId);
      await queryClient.invalidateQueries({
        queryKey: getConversationQuery(selectedId).queryKey,
      });
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setStopping(false);
    }
  };
  const capped = capReached(allowance);
  // Retry is disabled from the click until its request settles, so a double
  // click cannot hit assistant.busy.
  const [retrying, setRetrying] = React.useState(false);
  const retry = async () => {
    if (!selectedId || retrying) return;
    setRetrying(true);
    try {
      await retryAnswer(selectedId);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getConversationQuery(selectedId).queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: getAllowanceQuery().queryKey,
        }),
      ]);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setRetrying(false);
    }
  };

  // The conversation made for a first question whose send then failed: the
  // retry sends into it rather than leaving another empty one behind.
  const created = React.useRef<string | null>(null);

  // The current selection, for a send that resolves after the user moved on.
  const selectedRef = React.useRef(selectedId);
  React.useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);

  const send = async (
    text: string,
    attachments: AttachmentRef[],
    fileIds: string[]
  ) => {
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
      ...(fileIds.length > 0 ? { fileIds } : {}),
    });
    if (!selectedId && userId) {
      // A first question: New chat's chip starts over (the composer empties
      // what was sent), and the chat it created keeps the context just sent.
      composerDrafts.update(NEW_CHAT, (d) => ({ ...d, context: null }));
      composerDrafts.update(id, (d) =>
        d.context === null ? { ...d, context } : d
      );
    }
    if (id !== selectedRef.current) {
      created.current = null;
      // Only if the user is still on the new-conversation view: one who
      // opened another conversation while the send ran stays there.
      if (selectedRef.current === null) {
        // Opened only once its first question is stored: a read racing the
        // send could come back empty, and nothing would read it again.
        select(id);
      }
    }
  };

  const newDraft = (kind: DraftKind) => {
    setDraftsOpen(true);
    drafts.generate(kind);
  };

  const heading = <h1 className="sr-only">{t("title")}</h1>;

  if (!allowance.enabled) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto">
        {heading}
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
        {heading}
        <EmptyState
          icon={Bot}
          title={t("noProjectsTitle")}
          description={t("noProjectsDescription")}
        />
      </div>
    );
  }

  const chatOpen = selectedId !== null && !foreign;
  const toolbar = (showMeter(allowance) || chatOpen) && (
    <div className="mx-auto flex h-8 w-full max-w-3xl shrink-0 items-center justify-end gap-2">
      {showMeter(allowance) && <AllowanceBadge allowance={allowance} />}
      {chatOpen && (draftCount > 0 || draftsOpen) && (
        <Button
          variant="outline"
          size="sm"
          aria-expanded={draftsOpen}
          onClick={() => setDraftsOpen((open) => !open)}
        >
          <FileText data-icon="inline-start" />
          {t("drafts", { count: draftCount })}
        </Button>
      )}
      {chatOpen && (
        <DropdownMenu>
          <TooltipHint label={t("moreActions")}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("moreActions")}
                  disabled={
                    busy ||
                    capped ||
                    !canDraftFrom(conversation) ||
                    drafts.generating !== null
                  }
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
          </TooltipHint>
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
      )}
    </div>
  );

  const draftPanel = selectedId && !foreign && (
    <DraftPanel
      conversationId={selectedId}
      disabled={busy || capped}
      onClose={() => setDraftsOpen(false)}
    />
  );

  return (
    <div className="h-full min-h-0">
      {heading}
      <div
        className={cn(
          "flex h-full min-h-0 flex-col gap-6 lg:grid lg:grid-cols-[14rem_minmax(0,1fr)]",
          draftsOpen && selectedId && "lg:grid-cols-[14rem_minmax(0,1fr)_24rem]"
        )}
      >
        <div className="flex max-h-40 min-h-0 shrink-0 flex-col lg:max-h-none">
          <ConversationList
            selectedId={selectedId}
            onSelect={select}
            // New chat's draft, as it was left.
            onNew={() => select(null)}
            onDeleted={(id) => {
              if (created.current === id) created.current = null;
              // Its unsent text goes, and its unsent uploads are deleted.
              if (userId) composerDrafts.drop(id);
              // Deleting the open chat returns to a new one (and clears ?c=).
              if (id !== selectedRef.current) return;
              select(null);
              setDraftsOpen(false);
            }}
          />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
          {toolbar}
          {selectedId && !foreign ? (
            <ChatThread
              key={selectedId}
              conversationId={selectedId}
              onRetry={() => void retry()}
              retryDisabled={busy || capped || retrying}
            />
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
          <div className="mx-auto w-full max-w-3xl shrink-0">
            <Composer
              disabled={busy || capped}
              running={busy}
              stopping={stopping}
              onStop={() => void stop()}
              capResetsAt={capped ? allowance.resetsAt : null}
              readsImages={allowance.readsImages}
              onSend={send}
              focusKey={selectedId ?? "new"}
              draftKey={draftKey}
              userId={userId}
              context={context}
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
