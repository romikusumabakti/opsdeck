import { code } from "@streamdown/code";
import { useQuery } from "@tanstack/react-query";
import {
  FileText,
  FolderKanban,
  ImageIcon,
  Loader2,
  Paperclip,
  Pencil,
  RotateCcw,
  Server,
} from "lucide-react";
import * as React from "react";
import {
  type Components,
  defaultComponents,
  defaultRehypePlugins,
  type ExtraProps,
  Streamdown,
  type StreamdownProps,
} from "streamdown";
import { useTranslations } from "use-intl";
import { CopyButton } from "@/components/copy-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TooltipHint } from "@/components/ui/tooltip";
import { qualifiedEnvName } from "@/lib/nav-path";
import { cn, formatBytes } from "@/lib/utils";
import {
  type ConversationMessage,
  getAllowanceQuery,
  type MessageContext,
} from "@/web/api/assistant";
import { listProjectsQuery } from "@/web/api/project-catalog";
import { shouldSend } from "./composer-keys";
import { useAssistantErrorText } from "./error-text";
import { MessageSources } from "./message-sources";

type StyledTag = "table" | "thead" | "th" | "td" | "h1" | "h2" | "h3";
type StyledProps = { className?: string } & ExtraProps;

/** Streamdown's own renderer for `tag`, with `extra` merged over its classes. */
function Restyled({
  tag,
  extra,
  ...props
}: StyledProps & { tag: StyledTag; extra: string }) {
  const Base = defaultComponents[tag] as React.ComponentType<StyledProps>;
  return <Base {...props} className={cn(extra, props.className)} />;
}

/**
 * How an answer's elements render: Streamdown's components (tables in a
 * scrolling frame, code blocks with a copy button) at the chat's size, a
 * semantic <strong>, and two safety overrides. Images are never loaded (an injected
 * `![](https://…?d=<data>)` would leak data without a click; only the alt
 * text stays), and links open in a new tab without access to this page.
 */
const ANSWER_COMPONENTS: Components = {
  table: (props) => <Restyled tag="table" extra="text-sm" {...props} />,
  thead: (props) => <Restyled tag="thead" extra="bg-muted" {...props} />,
  th: (props) => <Restyled tag="th" extra="px-3 py-2" {...props} />,
  td: (props) => <Restyled tag="td" extra="px-3 py-2" {...props} />,
  h1: (props) => <Restyled tag="h1" extra="mt-4 text-lg" {...props} />,
  h2: (props) => <Restyled tag="h2" extra="mt-4 text-base" {...props} />,
  h3: (props) => <Restyled tag="h3" extra="mt-4 text-sm" {...props} />,
  // A real <strong> (Streamdown's is a styled span), for assistive tech.
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
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
};

type Pluggable = NonNullable<StreamdownProps["rehypePlugins"]>[number];

// Streamdown's rehype-harden with a blocked link (javascript: and other
// non-web URLs) left as its plain text: the default marks it with a
// hard-coded English " [blocked]" and "Blocked URL" tooltip.
const [harden, hardenOptions] = defaultRehypePlugins.harden as [
  Extract<Pluggable, unknown[]>[0],
  Record<string, unknown>,
];
const hardenTextOnly: Pluggable = [
  harden,
  { ...hardenOptions, linkBlockPolicy: "text-only" },
];

// Streamdown's rehype chain without `raw`, and `skipHtml` on the renderer:
// HTML inside an answer is never parsed into elements; it is dropped from
// the output (not shown as text).
const ANSWER_REHYPE_PLUGINS: Pluggable[] = [
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.undoubleClobberPrefix,
  hardenTextOnly,
].filter((p): p is Pluggable => p !== undefined);

const ANSWER_PLUGINS = { code };

// Copy on code blocks only: the answer has its own copy action, and tables
// grow with the answer rather than scrolling inside it.
const ANSWER_CONTROLS = {
  table: false,
  code: { copy: true, download: false },
  mermaid: false,
  image: false,
} as const;

// Our own links (above) instead of Streamdown's confirm-before-open dialog.
const ANSWER_LINK_SAFETY = { enabled: false };

/**
 * An answer's markdown, read-only, with Streamdown: an unfinished answer
 * renders while it streams (open emphasis, half a table or code fence),
 * GFM tables scroll sideways, code is highlighted (Shiki, JavaScript regex
 * engine: no eval, no remote fetch). Embedded HTML is never rendered as
 * HTML; a link to a non-web URL (javascript:) is blocked. Each block
 * takes the direction of its own text (an Arabic UI may get an English
 * answer, and the reverse).
 */
function AnswerMarkdown({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  const t = useTranslations("assistant");
  const tCommon = useTranslations("common");
  const translations = React.useMemo(
    () => ({ copyCode: t("copyCode"), copied: tCommon("copied") }),
    [t, tCommon]
  );
  return (
    <Streamdown
      data-answer-markdown=""
      dir="auto"
      className="text-sm leading-relaxed break-words"
      components={ANSWER_COMPONENTS}
      rehypePlugins={ANSWER_REHYPE_PLUGINS}
      skipHtml
      plugins={ANSWER_PLUGINS}
      controls={ANSWER_CONTROLS}
      linkSafety={ANSWER_LINK_SAFETY}
      tableMaxHeight={0}
      isAnimating={streaming}
      translations={translations}
    >
      {content}
    </Streamdown>
  );
}

/**
 * What a question was asked about, under its bubble: the project, or the
 * environment with its project's name (when the caller still sees that
 * project; else the name stored with the question), marked "(deleted)" once
 * that project or environment is gone. An automatic question (the default)
 * has no label.
 */
function QuestionContextLabel({ context }: { context: MessageContext }) {
  const t = useTranslations("assistant");
  const projects = useQuery(listProjectsQuery()).data;
  const project = projects?.find((p) => p.id === context.projectId);
  const Icon = context.kind === "project" ? FolderKanban : Server;
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

// Mirrors the API's limit (server/services/assistant.ts).
const MAX_MESSAGE_CHARS = 8000;

/**
 * The last question, edited in place: Enter or Send resends it (replacing
 * it and its answer), Escape or Cancel leaves it as it was. A refused resend
 * keeps the field open with the text (the caller says why).
 */
function QuestionEditor({
  initial,
  onSubmit,
  onCancel,
  disabled,
}: {
  initial: string;
  onSubmit: (text: string) => Promise<void>;
  onCancel: () => void;
  disabled: boolean;
}) {
  const t = useTranslations("assistant");
  const tCommon = useTranslations("common");
  const [value, setValue] = React.useState(initial);
  const [saving, setSaving] = React.useState(false);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const text = value.trim();
  const canSend =
    !disabled && !saving && text !== "" && text !== initial.trim();
  const submit = async () => {
    if (!canSend) return;
    setSaving(true);
    try {
      await onSubmit(text);
    } catch {
      // Said by the caller; the field stays open with the text.
    } finally {
      setSaving(false);
    }
  };
  return (
    <div data-edit-question className="flex w-full max-w-[85%] flex-col gap-2">
      <Textarea
        ref={ref}
        value={value}
        aria-label={t("editQuestion")}
        maxLength={MAX_MESSAGE_CHARS}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
            return;
          }
          if (
            shouldSend({
              key: e.key,
              shiftKey: e.shiftKey,
              isComposing: e.nativeEvent.isComposing,
              keyCode: e.keyCode,
            })
          ) {
            e.preventDefault();
            void submit();
          }
        }}
        className="max-h-60 rounded-2xl"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {tCommon("cancel")}
        </Button>
        <Button size="sm" disabled={!canSend} onClick={() => void submit()}>
          {t("send")}
        </Button>
      </div>
    </div>
  );
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
  onEdit,
  editDisabled = false,
}: {
  message: ConversationMessage;
  /** An answer to a question about project branches (not an environment). */
  projectBranches?: boolean;
  /** The thread's last message: its actions stay visible. */
  isLast?: boolean;
  /** Asks the assistant again; offered on the last answer only. */
  onRetry?: () => void;
  retryDisabled?: boolean;
  /**
   * Resends the question with new text (replacing it and its answer);
   * offered on the last question only. Rejects when refused.
   */
  onEdit?: (text: string) => Promise<void>;
  editDisabled?: boolean;
}) {
  const t = useTranslations("assistant");
  const [editing, setEditing] = React.useState(false);
  const { codeText } = useAssistantErrorText();
  // A failed message stores only its code: a turn stopped at the daily cap is
  // worded with the current allowance (loaded by the workspace already).
  const allowance = useQuery({
    ...getAllowanceQuery(),
    enabled: message.errorCode === "assistant.daily_cap_reached",
  }).data;

  if (message.role === "user") {
    // Automatic is the default: only a project or environment is named.
    const labelled = !!message.context && message.context.kind !== "auto";
    return (
      <div className="group/message flex flex-col items-end gap-1">
        {editing && onEdit ? (
          <QuestionEditor
            initial={message.content}
            disabled={editDisabled}
            onCancel={() => setEditing(false)}
            onSubmit={async (text) => {
              await onEdit(text);
              setEditing(false);
            }}
          />
        ) : (
          <>
            <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap break-words">
              {message.content}
            </div>
            <div data-message-actions className={actionsClass(false)}>
              <CopyButton value={message.content} label={t("copyQuestion")} />
              {onEdit && (
                <TooltipHint label={t("editQuestion")}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setEditing(true)}
                    disabled={editDisabled}
                    aria-label={t("editQuestion")}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                </TooltipHint>
              )}
            </div>
          </>
        )}
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
        {(labelled || message.attachmentIds.length > 0) && (
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {labelled && message.context && (
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
      {message.content && (
        <AnswerMarkdown content={message.content} streaming={pending} />
      )}
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
