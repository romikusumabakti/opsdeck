import { useQuery } from "@tanstack/react-query";
import {
  FileText,
  FolderKanban,
  ImageIcon,
  Loader2,
  Paperclip,
  RotateCcw,
  Server,
  Sparkles,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslations } from "use-intl";
import { CopyButton } from "@/components/copy-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { qualifiedEnvName } from "@/lib/nav-path";
import { formatBytes } from "@/lib/utils";
import {
  type ConversationMessage,
  getAllowanceQuery,
  type MessageContext,
} from "@/web/api/assistant";
import { listProjectsQuery } from "@/web/api/project-catalog";
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

/**
 * What a question was asked about, under its bubble: Automatic, the project,
 * or the environment with its project's name (when the caller still sees
 * that project; else the name stored with the question), marked "(deleted)"
 * once that project or environment is gone.
 */
function QuestionContextLabel({ context }: { context: MessageContext }) {
  const t = useTranslations("assistant");
  const projects = useQuery(listProjectsQuery()).data;
  const project = projects?.find((p) => p.id === context.projectId);
  const Icon =
    context.kind === "auto"
      ? Sparkles
      : context.kind === "project"
        ? FolderKanban
        : Server;
  let label = context.label ?? t("contextAuto");
  if (context.kind === "environment" && context.label && project) {
    label = qualifiedEnvName(context.label, project.name);
  }
  return (
    <span className="flex items-center gap-1">
      <Icon className="size-3" aria-hidden />
      <span data-question-context>
        {context.deleted ? `${label} ${t("contextDeleted")}` : label}
      </span>
    </span>
  );
}

/**
 * Actions under a message: hidden until the message is hovered or focused
 * (always visible on touch screens and on the last answer).
 */
function actionsClass(always: boolean) {
  return always
    ? "flex gap-1 opacity-100"
    : "flex gap-1 opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100 pointer-coarse:opacity-100";
}

/**
 * One message of the thread: the user's question, with what it asked about
 * and its attachments, or the assistant's answer.
 */
export function MessageView({
  message,
  projectBranches = false,
  isLast = false,
  onRetry,
  retryDisabled = false,
}: {
  message: ConversationMessage;
  /** An answer to a question about project branches (not an environment). */
  projectBranches?: boolean;
  /** The thread's last message: its actions stay visible. */
  isLast?: boolean;
  /** Asks the assistant again; offered on the last answer only. */
  onRetry?: () => void;
  retryDisabled?: boolean;
}) {
  const t = useTranslations("assistant");
  const { codeText } = useAssistantErrorText();
  // A failed message stores only its code: a turn stopped at the daily cap is
  // worded with the current allowance (loaded by the workspace already).
  const allowance = useQuery({
    ...getAllowanceQuery(),
    enabled: message.errorCode === "assistant.daily_cap_reached",
  }).data;

  if (message.role === "user") {
    return (
      <div className="group/message flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap break-words">
          {message.content}
        </div>
        <div data-message-actions className={actionsClass(false)}>
          <CopyButton value={message.content} label={t("copyQuestion")} />
        </div>
        {message.files.length > 0 && (
          <ul
            className="flex max-w-[85%] flex-wrap justify-end gap-1.5"
            aria-label={t("attachedFiles")}
          >
            {message.files.map((f) => (
              <li
                key={f.id}
                data-sent-file
                className="flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
              >
                {f.mediaType.startsWith("image/") ? (
                  <ImageIcon className="size-3.5 shrink-0" aria-hidden />
                ) : (
                  <FileText className="size-3.5 shrink-0" aria-hidden />
                )}
                <span className="truncate">{f.filename}</span>
                <span className="shrink-0 text-muted-foreground">
                  {formatBytes(f.size)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {(message.context || message.attachmentIds.length > 0) && (
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {message.context && (
              <QuestionContextLabel context={message.context} />
            )}
            {message.attachmentIds.length > 0 && (
              <span className="flex items-center gap-1">
                <Paperclip className="size-3" />
                {t("attachedCount", { count: message.attachmentIds.length })}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  const pending = message.status === "queued" || message.status === "streaming";
  return (
    <div className="group/message flex flex-col gap-2" aria-busy={pending}>
      {message.content && <AnswerMarkdown content={message.content} />}
      {pending && (
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {message.status === "queued" ? t("queued") : t("streaming")}
        </span>
      )}
      {message.status === "failed" &&
        message.errorCode === "assistant.stopped" && (
          <p className="text-xs text-muted-foreground">
            {codeText(message.errorCode)}
          </p>
        )}
      {message.status === "failed" &&
        message.errorCode !== "assistant.stopped" && (
          <Alert variant="destructive">
            <AlertDescription>
              {codeText(
                message.errorCode,
                allowance ? { resetsAt: allowance.resetsAt } : undefined
              )}
            </AlertDescription>
          </Alert>
        )}
      {!pending && (
        <MessageSources
          sources={message.sources}
          toolCalls={message.toolCalls}
          projectBranches={projectBranches}
        />
      )}
      {!pending && (
        <div data-message-actions className={actionsClass(isLast)}>
          {message.content && (
            <CopyButton value={message.content} label={t("copyAnswer")} />
          )}
          {isLast && onRetry && (
            <TooltipHint label={t("retry")}>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={onRetry}
                disabled={retryDisabled}
                aria-label={t("retry")}
                className="text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="size-3.5" />
              </Button>
            </TooltipHint>
          )}
        </div>
      )}
    </div>
  );
}
