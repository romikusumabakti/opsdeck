import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useTranslations } from "use-intl";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listConversationsQuery } from "@/web/api/assistant";

/**
 * The caller's conversations (all projects), newest first, each with what its
 * last question was about and when it changed. The list scrolls on its own
 * below the pinned "New conversation" button.
 */
export function ConversationList({
  selectedId,
  onSelect,
  onNew,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const t = useTranslations("assistant");
  const conversations = useQuery(listConversationsQuery()).data ?? [];

  return (
    <nav
      aria-label={t("conversations")}
      className="flex min-h-0 flex-col gap-2"
    >
      <Button
        variant="outline"
        onClick={onNew}
        className="shrink-0 justify-start"
      >
        <Plus data-icon="inline-start" />
        {t("newConversation")}
      </Button>
      {conversations.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">
          {t("noConversations")}
        </p>
      ) : (
        <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          {conversations.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                aria-current={c.id === selectedId ? "true" : undefined}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-start text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
                  c.id === selectedId && "bg-muted font-medium"
                )}
              >
                <span className="line-clamp-2 break-words">
                  {c.title || t("untitled")}
                </span>
                <span className="flex w-full min-w-0 items-baseline gap-1.5 text-xs font-normal text-muted-foreground">
                  <span className="truncate">
                    {c.lastContextLabel ?? t("contextAuto")}
                  </span>
                  <span aria-hidden>·</span>
                  <RelativeTime date={c.updatedAt} className="shrink-0" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
