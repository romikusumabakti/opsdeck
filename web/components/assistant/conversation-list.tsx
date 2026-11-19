import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { cn } from "@/lib/utils";
import {
  type ConversationSummary,
  deleteConversation,
  getConversationQuery,
  listConversationsQuery,
  pinConversation,
  renameConversation,
} from "@/web/api/assistant";
import { useAssistantErrorText } from "./error-text";

// The server's limits (TITLE_MAX_CHARS in lib/assistant/conversation-store.ts,
// SEARCH_QUERY_MAX_CHARS in the route schema).
const TITLE_MAX_CHARS = 80;
const SEARCH_MAX_CHARS = 200;
const SEARCH_DEBOUNCE_MS = 250;

const newestFirst = (a: ConversationSummary, b: ConversationSummary) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

/**
 * The caller's chats (all projects): a search field, then "Pinned" (most
 * recently pinned first) above "Recent" (newest first). A row is one line,
 * the title truncated, with a ⋯ menu to pin or unpin it, rename it (in
 * place: Enter or leaving the field saves, Escape cancels) or delete it
 * (after a confirmation). While a search is typed (debounced, server-side:
 * title or any message text of the caller's own chats) one flat list of its
 * results, newest first, replaces the sections; Escape clears it. The list
 * scrolls on its own below the "New chat" button and the search.
 */
export function ConversationList({
  selectedId,
  onSelect,
  onNew,
  onDeleted,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** After a chat was deleted, before its cached read is dropped. */
  onDeleted?: (id: string) => void;
}) {
  const t = useTranslations("assistant");
  const tCommon = useTranslations("common");
  const { errorText } = useAssistantErrorText();
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState("");
  const query = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const searching = query !== "";
  const list = useQuery({
    ...listConversationsQuery(searching ? query : undefined),
    // The previous results stay while the next query's load.
    placeholderData: searching ? keepPreviousData : undefined,
  }).data;
  // A section per heading (none while searching: one flat list of the
  // results, newest first); empty ones are left out.
  type Section = {
    key: string;
    heading?: string;
    rows: ConversationSummary[];
  };
  const sections: Section[] = (
    !list
      ? []
      : searching
        ? [
            {
              key: "results",
              rows: [...list.pinned, ...list.recent].sort(newestFirst),
            },
          ]
        : [
            { key: "pinned", heading: t("pinnedChats"), rows: list.pinned },
            { key: "recent", heading: t("recentChats"), rows: list.recent },
          ]
  ).filter((section) => section.rows.length > 0);
  const empty = list !== undefined && sections.length === 0;
  const pinnedIds = new Set(list?.pinned.map((c) => c.id));
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [titleTooLong, setTitleTooLong] = React.useState(false);
  // Escape cancels; the blur that may follow must not save.
  const cancelled = React.useRef(false);
  // Rename opens the title field once its menu has closed (handing focus
  // back to nothing), so the menu's focus handling (its highlighted item,
  // then its trigger) cannot take focus from the field: a blur saves it.
  const [renameAfterClose, setRenameAfterClose] = React.useState<string | null>(
    null
  );
  const [deleting, setDeleting] = React.useState<ConversationSummary | null>(
    null
  );

  const pin = useMutation({
    mutationFn: (input: { conversationId: string; pinned: boolean }) =>
      pinConversation(input),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: listConversationsQuery().queryKey,
      }),
    onError: (error) => toast.error(errorText(error)),
  });
  const rename = useMutation({
    mutationFn: (input: { conversationId: string; title: string }) =>
      renameConversation(input),
    onError: () => toast.error(tCommon("errorGeneric")),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteConversation(id),
    onSuccess: async (_result, id) => {
      setDeleting(null);
      // The open chat goes first, so nothing reads it again.
      onDeleted?.(id);
      queryClient.removeQueries({
        queryKey: getConversationQuery(id).queryKey,
      });
      await queryClient.invalidateQueries({
        queryKey: listConversationsQuery().queryKey,
      });
      toast.success(t("chatDeleted"));
    },
    onError: () => toast.error(tCommon("errorGeneric")),
  });

  const startEditing = (id: string) => {
    cancelled.current = false;
    setTitleTooLong(false);
    setEditingId(id);
  };
  const stopEditing = () => {
    cancelled.current = true;
    setEditingId(null);
  };

  /**
   * Saves a changed title, else (empty or unchanged) cancels. One over the
   * limit, in characters (code points, as the server counts), stays open
   * with the error.
   */
  const saveTitle = (conversation: ConversationSummary, value: string) => {
    if (cancelled.current) return;
    const title = value.trim().replace(/\s+/g, " ");
    if (Array.from(title).length > TITLE_MAX_CHARS) {
      setTitleTooLong(true);
      return;
    }
    stopEditing();
    if (!title || title === conversation.title) return;
    rename.mutate({ conversationId: conversation.id, title });
  };

  const renderRow = (c: ConversationSummary, pinned: boolean) => (
    <li key={c.id} className="group relative">
      {editingId === c.id ? (
        <div className="flex flex-col gap-1">
          <Input
            autoFocus
            aria-label={t("chatTitle")}
            aria-invalid={titleTooLong || undefined}
            aria-describedby={
              titleTooLong ? `chat-title-error-${c.id}` : undefined
            }
            defaultValue={c.title}
            onFocus={(event) => event.currentTarget.select()}
            onChange={() => setTitleTooLong(false)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                saveTitle(c, event.currentTarget.value);
              } else if (event.key === "Escape") {
                event.preventDefault();
                stopEditing();
              }
            }}
            onBlur={(event) => saveTitle(c, event.currentTarget.value)}
          />
          {titleTooLong && (
            <p
              id={`chat-title-error-${c.id}`}
              className="px-1 text-xs text-destructive"
            >
              {t("chatTitleTooLong", { max: TITLE_MAX_CHARS })}
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onSelect(c.id)}
          aria-current={c.id === selectedId ? "true" : undefined}
          title={c.title || t("untitled")}
          className={cn(
            "flex h-8 w-full items-center rounded-lg ps-2.5 pe-9 text-start text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
            c.id === selectedId && "bg-muted font-medium"
          )}
        >
          <span className="min-w-0 truncate">{c.title || t("untitled")}</span>
        </button>
      )}
      <DropdownMenu
        onOpenChangeComplete={(open) => {
          if (open || renameAfterClose !== c.id) return;
          setRenameAfterClose(null);
          startEditing(c.id);
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("chatActions")}
              className={cn(
                "absolute end-1 top-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100",
                editingId === c.id && "hidden"
              )}
            />
          }
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" finalFocus={renameAfterClose !== c.id}>
          <DropdownMenuItem
            onClick={() =>
              pin.mutate({ conversationId: c.id, pinned: !pinned })
            }
          >
            {pinned ? <PinOff /> : <Pin />}
            {pinned ? t("unpinChat") : t("pinChat")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setRenameAfterClose(c.id)}>
            <Pencil />
            {t("renameChat")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setDeleting(c)}
          >
            <Trash2 />
            {t("deleteChat")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );

  return (
    <nav aria-label={t("chats")} className="flex min-h-0 flex-col gap-2">
      <Button
        variant="outline"
        onClick={onNew}
        className="shrink-0 justify-start"
      >
        <Plus data-icon="inline-start" />
        {t("newChat")}
      </Button>
      <InputGroup className="shrink-0">
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          value={search}
          maxLength={SEARCH_MAX_CHARS}
          placeholder={t("searchChats")}
          aria-label={t("searchChats")}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && search !== "") {
              event.preventDefault();
              setSearch("");
            }
          }}
        />
      </InputGroup>
      {empty ? (
        <p className="px-2 text-sm text-muted-foreground">
          {searching ? t("noChatsFound") : t("noChats")}
        </p>
      ) : (
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          {sections.map((section) => (
            <section key={section.key} className="flex flex-col gap-0.5">
              {section.heading && (
                <h2 className="px-2.5 py-1 text-xs font-medium text-muted-foreground">
                  {section.heading}
                </h2>
              )}
              <ul className="flex flex-col gap-0.5">
                {section.rows.map((c) => renderRow(c, pinnedIds.has(c.id)))}
              </ul>
            </section>
          ))}
        </div>
      )}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteChatConfirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteChatDescription", {
                title: deleting?.title || t("untitled"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>
              {tCommon("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              {t("deleteChat")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </nav>
  );
}
