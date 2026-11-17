import { Paperclip, SendHorizontal, X } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AttachmentRef } from "@/lib/assistant/attachment-refs";
import { AttachmentPicker, type PickedAttachment } from "./attachment-picker";
import { shouldSend } from "./composer-keys";
import { useAssistantErrorText } from "./error-text";

// Mirrors the API's limits (server/services/assistant.ts).
const MAX_MESSAGE_CHARS = 8000;
const MAX_ATTACHMENTS = 10;

/**
 * The question box: text, the ticked Jira attachments, and the send. A refused
 * send (daily cap, busy, not configured) is shown above the box, worded from
 * its code; the text is kept so it can be sent again.
 */
export function Composer({
  environmentId,
  disabled,
  onSend,
  focusKey,
}: {
  environmentId: string;
  /** An answer is still running, or the assistant cannot take questions. */
  disabled: boolean;
  onSend: (text: string, attachments: AttachmentRef[]) => Promise<void>;
  /** The box takes focus on mount and whenever this changes. */
  focusKey: string | null;
}) {
  const t = useTranslations("assistant");
  const { errorText } = useAssistantErrorText();
  const [text, setText] = React.useState("");
  const [attachments, setAttachments] = React.useState<PickedAttachment[]>([]);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusKey is the trigger.
  React.useEffect(() => {
    textareaRef.current?.focus();
  }, [focusKey]);

  const canSend = !disabled && !sending && text.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await onSend(
        text.trim(),
        attachments.map((a) => ({ issueKey: a.issueKey, attachmentId: a.id }))
      );
      setText("");
      setAttachments([]);
      textareaRef.current?.focus();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };

  const add = (picked: PickedAttachment[]) =>
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.id));
      return [...prev, ...picked.filter((a) => !seen.has(a.id))].slice(
        0,
        MAX_ATTACHMENTS
      );
    });

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <ul className="flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <li key={a.id}>
                <Badge variant="secondary" className="max-w-64">
                  <span className="truncate">
                    {a.issueKey} · {a.filename}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setAttachments((prev) =>
                        prev.filter((p) => p.id !== a.id)
                      )
                    }
                    aria-label={t("removeAttachment", { name: a.filename })}
                    className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <X />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
          <p className="text-xs text-amber-600 dark:text-amber-500">
            {t("attachmentWarning")}
          </p>
        </div>
      )}
      <Textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
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
            void send();
          }
        }}
        placeholder={t("placeholder")}
        aria-label={t("placeholder")}
        maxLength={MAX_MESSAGE_CHARS}
        rows={3}
        className="max-h-60 resize-none"
      />
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPickerOpen(true)}
          disabled={attachments.length >= MAX_ATTACHMENTS}
        >
          <Paperclip data-icon="inline-start" />
          {t("attachments")}
        </Button>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {t("sendHint")}
          </span>
          <Button size="sm" onClick={() => void send()} disabled={!canSend}>
            <SendHorizontal data-icon="inline-start" />
            {t("send")}
          </Button>
        </div>
      </div>
      <AttachmentPicker
        environmentId={environmentId}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        max={MAX_ATTACHMENTS}
        picked={new Set(attachments.map((a) => a.id))}
        onAdd={add}
      />
    </div>
  );
}
