import { Loader2, Paperclip } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslations } from "use-intl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { ConversationMessage } from "@/web/api/assistant";
import { useAssistantErrorText } from "./error-text";
import { MessageSources } from "./message-sources";

/**
 * An answer's markdown, read-only: embedded HTML is dropped (`skipHtml`),
 * images are never loaded (an injected `![](https://…?d=<data>)` would leak
 * data without a click; only the alt text stays), and links open in a new
 * tab without access to this page.
 */
function AnswerMarkdown({ content }: { content: string }) {
  return (
    <div className="flex flex-col gap-2 text-sm leading-relaxed break-words [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:ps-5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:text-xs [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2 [&_ul]:list-disc [&_ul]:ps-5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          // Never an <img> (nor React's preload of one): the alt text only.
          img: ({ alt }) => (alt ? <span>{alt}</span> : null),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-4"
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** One message of the thread: the user's question or the assistant's answer. */
export function MessageView({ message }: { message: ConversationMessage }) {
  const t = useTranslations("assistant");
  const { codeText } = useAssistantErrorText();

  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap break-words">
          {message.content}
        </div>
        {message.attachmentIds.length > 0 && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Paperclip className="size-3" />
            {t("attachedCount", { count: message.attachmentIds.length })}
          </span>
        )}
      </div>
    );
  }

  const pending = message.status === "queued" || message.status === "streaming";
  return (
    <div className="flex flex-col gap-2" aria-busy={pending}>
      {message.content && <AnswerMarkdown content={message.content} />}
      {pending && (
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {message.status === "queued" ? t("queued") : t("streaming")}
        </span>
      )}
      {message.status === "failed" && (
        <Alert variant="destructive">
          <AlertDescription>{codeText(message.errorCode)}</AlertDescription>
        </Alert>
      )}
      {message.status === "done" && (
        <p className="text-xs text-muted-foreground">{t("disclaimer")}</p>
      )}
      {!pending && (
        <MessageSources
          sources={message.sources}
          toolCalls={message.toolCalls}
        />
      )}
    </div>
  );
}
