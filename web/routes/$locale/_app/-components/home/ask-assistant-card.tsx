import { useMutation, useQuery } from "@tanstack/react-query";
import { SendHorizontal } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Link, useRouter } from "@/i18n/navigation";
import type { QuestionContextInput } from "@/lib/assistant/context";
import { cn } from "@/lib/utils";
import {
  createConversation,
  getAllowanceQuery,
  listConversationsQuery,
  sendMessage,
} from "@/web/api/assistant";
import { listProjectsQuery } from "@/web/api/project-catalog";
import {
  opensContextPicker,
  shouldSend,
} from "@/web/components/assistant/composer-keys";
import {
  ContextPicker,
  useContextOptions,
  visibleContext,
} from "@/web/components/assistant/context-picker";
import { useAssistantErrorText } from "@/web/components/assistant/error-text";

const AUTO: QuestionContextInput = { kind: "auto" };
const EXAMPLE_KEYS = ["first", "second", "third"] as const;
const MAX_RECENTS = 3;

/**
 * Starts a conversation from Home: type a question, pick what it is about
 * (Automatic by default), Enter. The answer is followed on /assistant, which
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
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // The conversation made for a send that then failed: a retry reuses it
  // instead of leaving another empty one behind. Conversations are global,
  // so a changed context does not matter.
  const created = React.useRef<string | null>(null);

  const context = visibleContext(picked, options);

  const ask = useMutation({
    mutationFn: async (input: {
      context: QuestionContextInput;
      text: string;
    }) => {
      const id = created.current ?? (await createConversation()).id;
      created.current = id;
      await sendMessage({
        conversationId: id,
        text: input.text,
        context: input.context,
      });
      created.current = null;
      return id;
    },
    onSuccess: (conversationId) =>
      router.push(`/assistant?c=${conversationId}`),
  });

  if (!allowance?.enabled || !projects || projects.length === 0) return null;

  const capped = allowance.capReached;
  const canSend =
    !capped && !ask.isPending && !ask.isSuccess && text.trim() !== "";
  const submit = () => {
    if (canSend) ask.mutate({ context, text: text.trim() });
  };
  const message = capped
    ? codeText("assistant.daily_cap_reached", { resetsAt: allowance.resetsAt })
    : ask.isError
      ? errorText(ask.error)
      : null;
  const locked = capped || ask.isPending;
  const recents = conversations?.slice(0, MAX_RECENTS);

  return (
    <section className="flex flex-col gap-3">
      <div
        className={cn(
          "flex flex-col gap-2 rounded-2xl border bg-card p-3 shadow-xs transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
          locked && "opacity-70"
        )}
      >
        <textarea
          ref={textareaRef}
          rows={2}
          value={text}
          onChange={(e) => {
            const next = e.target.value;
            if (!locked && opensContextPicker(text, next)) {
              setPickerOpen(true);
              return;
            }
            setText(next);
          }}
          onKeyDown={(e) => {
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
        <div className="flex items-center justify-between gap-2">
          <ContextPicker
            value={context}
            onChange={(next) => {
              setPicked(next);
              textareaRef.current?.focus();
            }}
            disabled={locked}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
          />
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
