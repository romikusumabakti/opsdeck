import { Paperclip, SendHorizontal, Ticket, Upload, X } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import type { AttachmentRef } from "@/lib/assistant/attachment-refs";
import type { QuestionContextInput } from "@/lib/assistant/context";
import { UPLOAD_ACCEPT } from "@/lib/assistant/upload-types";
import { ASSISTANT_COMPOSER_ID } from "./assistant-shortcut";
import { AttachmentPicker, type PickedAttachment } from "./attachment-picker";
import { shouldSend } from "./composer-keys";
import { ContextPicker } from "./context-picker";
import { useAssistantErrorText } from "./error-text";
import {
  DropOverlay,
  FileChips,
  useFileDrop,
  useFileUploads,
} from "./file-chips";
import { useMentions } from "./mention-popover";

// Mirrors the API's limits (server/services/assistant.ts).
const MAX_MESSAGE_CHARS = 8000;
const MAX_ATTACHMENTS = 10;

/**
 * The question box: text, uploaded files and ticked Jira attachments (one
 * Attach menu: "Upload files" or "From an issue"; files can also be dropped
 * on the box or pasted), the context chip and the send. An `@` mention
 * anywhere in the text sets the chip too (see `useMentions`). A refused send
 * (daily cap, busy, not configured) is shown above the box, worded from its
 * code; the text and files are kept so it can be sent again.
 */
export function Composer({
  disabled,
  onSend,
  focusKey,
  context,
  onContextChange,
  capResetsAt,
  readsImages = true,
}: {
  /** An answer is still running, or the assistant cannot take questions. */
  disabled: boolean;
  onSend: (
    text: string,
    attachments: AttachmentRef[],
    fileIds: string[]
  ) => Promise<void>;
  /** The box takes focus on mount and whenever this changes. */
  focusKey: string | null;
  /** What the next question is about (the chip beside the attachments). */
  context: QuestionContextInput;
  onContextChange: (context: QuestionContextInput) => void;
  /** Set (ISO) when today's limit is reached: says when it resets. */
  capResetsAt?: string | null;
  /** False: the configured model cannot view images (said under them). */
  readsImages?: boolean;
}) {
  const t = useTranslations("assistant");
  const { errorText } = useAssistantErrorText();
  const [text, setText] = React.useState("");
  const [attachments, setAttachments] = React.useState<PickedAttachment[]>([]);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const uploads = useFileUploads();
  // Files can be added while an answer runs, for the next question; past
  // the limit, add() says so.
  const drop = useFileDrop(uploads.add, false);
  const mentions = useMentions({
    text,
    onTextChange: setText,
    onPick: onContextChange,
    textareaRef,
    disabled,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusKey is the trigger.
  React.useEffect(() => {
    textareaRef.current?.focus();
  }, [focusKey]);

  const canSend =
    !disabled && !sending && !uploads.uploading && text.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await onSend(
        text.trim(),
        attachments.map((a) => ({ issueKey: a.issueKey, attachmentId: a.id })),
        uploads.fileIds
      );
      setText("");
      setAttachments([]);
      uploads.clear();
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

  // A container, so the footer adapts to the chat column, not the viewport.
  return (
    <div
      className="@container/composer relative flex flex-col gap-2"
      {...drop.dropProps}
    >
      <DropOverlay show={drop.dragging} />
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
      <FileChips uploads={uploads} readsImages={readsImages} />
      {capResetsAt && (
        <p className="text-sm text-destructive" role="status">
          {t("usageCapReached", { time: new Date(capResetsAt) })}
        </p>
      )}
      <Textarea
        ref={textareaRef}
        id={ASSISTANT_COMPOSER_ID}
        value={text}
        {...mentions.inputProps}
        onChange={mentions.onChange}
        onSelect={mentions.onSelect}
        onPaste={drop.onPaste}
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
        <div className="flex min-w-0 items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="sm" />}
            >
              <Paperclip data-icon="inline-start" />
              {t("attach")}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                disabled={uploads.full}
                onClick={() => fileInput.current?.click()}
              >
                <Upload />
                {t("attachFiles")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={attachments.length >= MAX_ATTACHMENTS}
                onClick={() => setPickerOpen(true)}
              >
                <Ticket />
                {t("attachFromIssue")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept={UPLOAD_ACCEPT}
            data-testid="composer-file-input"
            onChange={(e) => {
              uploads.add(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <ContextPicker
            value={context}
            onChange={onContextChange}
            disabled={disabled}
          />
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground @2xl/composer:inline">
            {t("sendHint")}
          </span>
          <Button size="sm" onClick={() => void send()} disabled={!canSend}>
            <SendHorizontal data-icon="inline-start" />
            {t("send")}
          </Button>
        </div>
      </div>
      {mentions.popover}
      <AttachmentPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        max={MAX_ATTACHMENTS}
        picked={new Set(attachments.map((a) => a.id))}
        onAdd={add}
      />
    </div>
  );
}
