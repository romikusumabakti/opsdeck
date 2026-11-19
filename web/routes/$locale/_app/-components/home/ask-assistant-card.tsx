import { useMutation, useQuery } from "@tanstack/react-query";
import { Paperclip, SendHorizontal } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Link, useRouter } from "@/i18n/navigation";
import type { QuestionContextInput } from "@/lib/assistant/context";
import { UPLOAD_ACCEPT } from "@/lib/assistant/upload-types";
import { cn } from "@/lib/utils";
import {
  createConversation,
  getAllowanceQuery,
  listConversationsQuery,
  sendMessage,
} from "@/web/api/assistant";
import { listProjectsQuery } from "@/web/api/project-catalog";
import {
  composerDrafts,
  useDraftUser,
} from "@/web/components/assistant/composer-drafts";
import { shouldSend } from "@/web/components/assistant/composer-keys";
import {
  ContextPicker,
  useContextOptions,
  visibleContext,
} from "@/web/components/assistant/context-picker";
import { useAssistantErrorText } from "@/web/components/assistant/error-text";
import {
  DropOverlay,
  FileChips,
  useFileDrop,
  useFileUploads,
} from "@/web/components/assistant/file-chips";
import { useMentions } from "@/web/components/assistant/mention-popover";

const AUTO: QuestionContextInput = { kind: "auto" };
const EXAMPLE_KEYS = ["first", "second", "third"] as const;
const MAX_RECENTS = 3;

/**
 * Starts a conversation from Home: type a question, pick what it is about
 * (Automatic by default; the chip or an `@` mention in the text), attach
 * files (📎, drop or paste), Enter. The answer is followed on /assistant, which
 * the send navigates to. Below the box: the latest conversations, or example
 * questions that fill the box. Hidden unless the assistant is on and the
 * user sees a project.
 */
export function AskAssistantCard() {
  const t = useTranslations("homePage");
  const tAssistant = useTranslations("assistant");
  const { codeText, errorText } = useAssistantErrorText();
  const router = useRouter();
  const allowance = useQuery(getAllowanceQuery()).data;
  const projects = useQuery(listProjectsQuery()).data;
  const conversations = useQuery({
    ...listConversationsQuery(),
    enabled: allowance?.enabled === true && (projects?.length ?? 0) > 0,
  }).data;
  const options = useContextOptions();
  const [picked, setPicked] = React.useState<QuestionContextInput>(AUTO);
  const [text, setText] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const userId = useDraftUser();
  // The card keeps no draft across mounts: its own key, dropped (unsent
  // uploads deleted) on unmount and reset after a send. A send still pending
  // at unmount owns its files: they go with the question (or, if it fails,
  // are left to the daily prune).
  const draftKey = React.useId();
  const sending = React.useRef(false);
  React.useEffect(
    () => () => {
      if (!sending.current) composerDrafts.drop(draftKey);
    },
    [draftKey]
  );
  const uploads = useFileUploads(userId, draftKey);
  const drop = useFileDrop(uploads.add, false);

  // The conversation made for a send that then failed: a retry reuses it
  // instead of leaving another empty one behind. Conversations are global,
  // so a changed context does not matter.
  const created = React.useRef<string | null>(null);

  const context = visibleContext(picked, options);

  const ask = useMutation({
    mutationFn: async (input: {
      context: QuestionContextInput;
      text: string;
      fileIds: string[];
    }) => {
      sending.current = true;
      try {
        const id = created.current ?? (await createConversation()).id;
        created.current = id;
        await sendMessage({
          conversationId: id,
          text: input.text,
          context: input.context,
          ...(input.fileIds.length > 0 ? { fileIds: input.fileIds } : {}),
        });
        created.current = null;
        return id;
      } finally {
        sending.current = false;
      }
    },
    onSuccess: (conversationId) => {
      composerDrafts.clear(draftKey);
      router.push(`/assistant?c=${conversationId}`);
    },
  });

  const mentions = useMentions({
    text,
    onTextChange: setText,
    onPick: setPicked,
    textareaRef,
    disabled: allowance?.capReached === true || ask.isPending,
  });

  if (!allowance?.enabled || !projects || projects.length === 0) return null;

  const capped = allowance.capReached;
  const canSend =
    !capped &&
    !ask.isPending &&
    !ask.isSuccess &&
    !uploads.uploading &&
    text.trim() !== "";
  const submit = () => {
    if (canSend) {
      ask.mutate({ context, text: text.trim(), fileIds: uploads.fileIds });
    }
  };
  const message = capped
    ? codeText("assistant.daily_cap_reached", { resetsAt: allowance.resetsAt })
    : ask.isError
      ? errorText(ask.error)
      : null;
  const locked = capped || ask.isPending;
  // The latest chats, pinned or not.
  const recents = conversations
    ? [...conversations.pinned, ...conversations.recent]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, MAX_RECENTS)
    : undefined;

  return (
    <section className="flex flex-col gap-3">
      <div
        className={cn(
          "relative flex flex-col gap-2 rounded-2xl border bg-card p-3 shadow-xs transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          locked && "opacity-70"
        )}
        {...(locked ? {} : drop.dropProps)}
      >
        <DropOverlay show={drop.dragging && !locked} />
        <textarea
          ref={textareaRef}
          rows={2}
          value={text}
          {...mentions.inputProps}
          onChange={mentions.onChange}
          onSelect={mentions.onSelect}
          onPaste={locked ? undefined : drop.onPaste}
          onKeyDown={(e) => {
            if (mentions.onKeyDown(e)) return;
            if (
              shouldSend({
                key: e.key,
                shiftKey: e.shiftKey,
                isComposing: e.nativeEvent.isComposing,
                keyCode: e.keyCode,
              })
            ) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t("askPlaceholder")}
          aria-label={t("askPlaceholder")}
          disabled={locked}
          className="field-sizing-content max-h-36 min-h-12 w-full resize-none border-0 bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground md:text-sm"
        />
        <FileChips uploads={uploads} readsImages={allowance.readsImages} />
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              aria-label={tAssistant("attachFiles")}
              disabled={locked || uploads.full}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip />
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept={UPLOAD_ACCEPT}
              data-testid="home-file-input"
              onChange={(e) => {
                uploads.add(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
            <ContextPicker
              value={context}
              onChange={(next) => {
                setPicked(next);
                textareaRef.current?.focus();
              }}
              disabled={locked}
            />
          </div>
          <Button
            size="icon"
            className="rounded-full"
            aria-label={tAssistant("send")}
            disabled={!canSend}
            onClick={submit}
          >
            <SendHorizontal />
          </Button>
        </div>
        {mentions.popover}
      </div>
      {message ? (
        <p
          role={capped ? "status" : "alert"}
          className={cn(
            "px-1 text-xs",
            capped ? "text-amber-600 dark:text-amber-500" : "text-destructive"
          )}
        >
          {message}
        </p>
      ) : null}
      {/* Nothing until the conversations load: examples must not flash. */}
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
              disabled={locked}
              onClick={() => {
                setText(t(`askExamples.${key}`));
                textareaRef.current?.focus();
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
