import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { RelativeTime } from "@/components/relative-time";
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
import { cn } from "@/lib/utils";
import {
  type ConversationSummary,
  deleteConversation,
  getConversationQuery,
  listConversationsQuery,
  renameConversation,
} from "@/web/api/assistant";

// The server's limit (TITLE_MAX_CHARS in lib/assistant/conversation-store.ts).
const TITLE_MAX_CHARS = 80;

/**
 * The caller's chats (all projects), newest first, each with what its last
 * question was about and when it changed, and a ⋯ menu to rename it (in
 * place: Enter saves, Escape or leaving the field cancels) or delete it
 * (after a confirmation). The list scrolls on its own below the pinned "New
 * chat" button.
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
  const queryClient = useQueryClient();
  const conversations = useQuery(listConversationsQuery()).data ?? [];
  const [editingId, setEditingId] = React.useState<string | null>(null);
  // The menu hands focus to the title field it opened, not back to itself.
  const titleInput = React.useRef<HTMLInputElement>(null);
  const [deleting, setDeleting] = React.useState<ConversationSummary | null>(
    null
  );

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

  const saveTitle = (conversation: ConversationSummary, value: string) => {
    setEditingId(null);
    const title = value.trim().replace(/\s+/g, " ");
    if (!title || title === conversation.title) return;
    rename.mutate({ conversationId: conversation.id, title });
  };

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
      {conversations.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">{t("noChats")}</p>
      ) : (
        <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          {conversations.map((c) => (
            <li key={c.id} className="group relative">
              {editingId === c.id ? (
                <Input
                  ref={titleInput}
                  autoFocus
                  aria-label={t("chatTitle")}
                  defaultValue={c.title}
                  maxLength={TITLE_MAX_CHARS}
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      saveTitle(c, event.currentTarget.value);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingId(null);
                    }
                  }}
                  onBlur={() => setEditingId(null)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  aria-current={c.id === selectedId ? "true" : undefined}
                  className={cn(
                    "flex w-full flex-col items-start gap-0.5 rounded-lg py-2 ps-2.5 pe-9 text-start text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
                    c.id === selectedId && "bg-muted font-medium"
                  )}
                >
                  <span className="line-clamp-2 break-words">
                    {c.title || t("untitled")}
                  </span>
                  <span className="flex w-full min-w-0 items-baseline gap-1.5 text-xs font-normal text-muted-foreground">
                    <span className="truncate">
                      {c.lastContextLabel === null
                        ? t("contextAuto")
                        : c.lastContextDeleted
                          ? `${c.lastContextLabel} ${t("contextDeleted")}`
                          : c.lastContextLabel}
                    </span>
                    <span aria-hidden>·</span>
                    <RelativeTime date={c.updatedAt} className="shrink-0" />
                  </span>
                </button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("chatActions")}
                      className={cn(
                        "absolute end-1.5 top-2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100",
                        editingId === c.id && "hidden"
                      )}
                    />
                  }
                >
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  finalFocus={editingId === c.id ? titleInput : true}
                >
                  <DropdownMenuItem onClick={() => setEditingId(c.id)}>
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
          ))}
        </ul>
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
