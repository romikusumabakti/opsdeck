import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useTranslations } from "use-intl";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Link, useRouter } from "@/i18n/navigation";
import type { AttachmentRef } from "@/lib/assistant/attachment-refs";
import type { QuestionContextInput } from "@/lib/assistant/context";
import {
  createConversation,
  getAllowanceQuery,
  listConversationsQuery,
  sendMessage,
} from "@/web/api/assistant";
import { listProjectsQuery } from "@/web/api/project-catalog";
import { ASSISTANT_COMPOSER_ID } from "@/web/components/assistant/assistant-shortcut";
import { Composer } from "@/web/components/assistant/composer";
import {
  composerDrafts,
  NEW_CHAT,
  useComposerDraft,
  useDraftUser,
} from "@/web/components/assistant/composer-drafts";
import {
  useContextOptions,
  visibleContext,
} from "@/web/components/assistant/context-picker";

const AUTO: QuestionContextInput = { kind: "auto" };
const EXAMPLE_KEYS = ["first", "second", "third"] as const;
const MAX_RECENTS = 3;

/**
 * Starts a chat from Home with the Assistant's own composer: Home's box IS
 * New chat's, so what is typed, attached or picked here is the same draft
 * the Assistant shows under New chat (kept when leaving, cleared by a send).
 * The send creates the chat and opens it on /assistant. Below the box: the
 * latest chats, or example questions that fill the box. Hidden unless the
 * assistant is on and the user sees a project.
 */
export function AskAssistantCard() {
  const t = useTranslations("homePage");
  const tAssistant = useTranslations("assistant");
  const router = useRouter();
  const allowance = useQuery(getAllowanceQuery()).data;
  const projects = useQuery(listProjectsQuery()).data;
  const conversations = useQuery({
    ...listConversationsQuery(),
    enabled: allowance?.enabled === true && (projects?.length ?? 0) > 0,
  }).data;
  const options = useContextOptions();
  const userId = useDraftUser();
  const [draft] = useComposerDraft(userId, NEW_CHAT);
  // New chat's chip, Automatic until picked (as on the Assistant page).
  const context = visibleContext(draft.context ?? AUTO, options);

  // The chat made for a send that then failed: a retry reuses it instead of
  // leaving another empty one behind. Chats are global, so a changed
  // context does not matter.
  const created = React.useRef<string | null>(null);

  if (!allowance?.enabled || !projects || projects.length === 0) return null;

  const capped = allowance.capReached;

  const send = async (
    text: string,
    attachments: AttachmentRef[],
    fileIds: string[]
  ) => {
    const id = created.current ?? (await createConversation()).id;
    created.current = id;
    await sendMessage({
      conversationId: id,
      text,
      context,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(fileIds.length > 0 ? { fileIds } : {}),
    });
    created.current = null;
    // As after a first question on the Assistant page: New chat's chip
    // starts over (the composer empties what was sent), and the chat it
    // made keeps the context just sent.
    composerDrafts.update(NEW_CHAT, (d) => ({ ...d, context: null }));
    composerDrafts.update(id, (d) =>
      d.context === null ? { ...d, context } : d
    );
    router.push(`/assistant?c=${id}`);
  };

  // The latest chats, pinned or not.
  const recents = conversations
    ? [...conversations.pinned, ...conversations.recent]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, MAX_RECENTS)
    : undefined;

  return (
    <section className="flex flex-col gap-3">
      <Composer
        disabled={capped}
        running={false}
        onStop={() => {}}
        onSend={send}
        focusKey={NEW_CHAT}
        autoFocus={false}
        draftKey={NEW_CHAT}
        userId={userId}
        context={context}
        capResetsAt={capped ? allowance.resetsAt : null}
        readsImages={allowance.readsImages}
      />
      {/* Nothing until the chats load: examples must not flash. */}
      {recents === undefined ? null : recents.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h2 className="px-1 text-xs font-medium text-muted-foreground">
            {t("askRecent")}
          </h2>
          <ul className="flex flex-col">
            {recents.map((c) => (
              <li key={c.id}>
                <Link
                  data-recent
                  href={`/assistant?c=${c.id}`}
                  className="flex flex-col gap-0.5 rounded-lg px-2 py-1.5 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="truncate">
                    {c.title || tAssistant("untitled")}
                  </span>
                  <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
                    <span className="truncate">
                      {c.lastContextLabel === null
                        ? tAssistant("contextAuto")
                        : c.lastContextDeleted
                          ? `${c.lastContextLabel} ${tAssistant("contextDeleted")}`
                          : c.lastContextLabel}
                    </span>
                    <span aria-hidden>·</span>
                    <RelativeTime date={c.updatedAt} className="shrink-0" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {EXAMPLE_KEYS.map((key) => (
            <Button
              key={key}
              data-example
              variant="outline"
              size="sm"
              className="h-auto max-w-full whitespace-normal rounded-full py-1 text-start font-normal"
              disabled={capped}
              onClick={() => {
                composerDrafts.update(NEW_CHAT, (d) => ({
                  ...d,
                  text: t(`askExamples.${key}`),
                }));
                document.getElementById(ASSISTANT_COMPOSER_ID)?.focus();
              }}
            >
              {t(`askExamples.${key}`)}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
