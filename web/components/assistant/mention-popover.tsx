import { Popover } from "@base-ui/react/popover";
import { FolderKanban, Server } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import type { QuestionContextInput } from "@/lib/assistant/context";
import { useContextOptions } from "./context-picker";
import {
  activeMention,
  applyMention,
  type MentionMatch,
  mentionMatches,
} from "./mentions";

/** How long "no match" stays up before the list gets out of the way. */
const EMPTY_NOTICE_MS = 1500;

/**
 * `@` mentions for a question box, shared by the composer and the Home box.
 * While the caret is in an `@word` (see `activeMention`), a list under the
 * box offers the projects, then the environments, matching it; ↑/↓ move,
 * Enter or Tab pick, Esc closes and leaves the text. A pick puts `@<name> `
 * into the text and makes it the question's context (`onPick`, the same
 * state as the chip; the last pick wins). With no match, a short notice and
 * Enter sends as usual. An IME composition never picks.
 *
 * The box wires `onChange`, `onSelect` and `inputProps` to its textarea and
 * calls `onKeyDown` first in its own keydown handler: true means the key was
 * the list's. `popover` is rendered anywhere (it portals).
 */
export function useMentions({
  text,
  onTextChange,
  onPick,
  textareaRef,
  disabled,
}: {
  text: string;
  onTextChange: (text: string) => void;
  onPick: (context: QuestionContextInput) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
}) {
  const t = useTranslations("assistant");
  const { loaded, projects } = useContextOptions();
  const listId = React.useId();
  const [caret, setCaret] = React.useState(0);
  // The mention (by its `@`'s offset) closed with Esc, or whose "no match"
  // notice has had its moment.
  const [dismissed, setDismissed] = React.useState<number | null>(null);
  const [emptyDone, setEmptyDone] = React.useState<number | null>(null);
  const [highlight, setHighlight] = React.useState({ key: "", index: 0 });
  const pendingCaret = React.useRef<number | null>(null);

  const mention = disabled || !loaded ? null : activeMention(text, caret);
  const matches = mention ? mentionMatches(projects, mention.query) : [];
  const key = mention ? `${mention.start}:${mention.query}` : "";
  const index =
    highlight.key === key ? Math.min(highlight.index, matches.length - 1) : 0;
  const empty = mention !== null && matches.length === 0;
  const open =
    mention !== null &&
    mention.start !== dismissed &&
    !(empty && emptyDone === mention.start);
  const listOpen = open && !empty;

  const emptyAt = open && empty ? mention.start : null;
  React.useEffect(() => {
    if (emptyAt === null) return;
    const timer = setTimeout(() => setEmptyDone(emptyAt), EMPTY_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [emptyAt]);

  // A pick replaced the text: put the caret after the inserted mention.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once the picked text is in.
  React.useLayoutEffect(() => {
    const at = pendingCaret.current;
    const box = textareaRef.current;
    if (at === null || !box) return;
    pendingCaret.current = null;
    box.focus();
    box.setSelectionRange(at, at);
    // Again: a select event of the pick's own key may have read the old one.
    setCaret(at);
  }, [text]);

  const pick = (match: MentionMatch) => {
    if (!mention) return;
    const next = applyMention(text, mention, match.label);
    pendingCaret.current = next.caret;
    onTextChange(next.text);
    onPick(match.context);
  };

  const track = (box: HTMLTextAreaElement) => {
    const at = box.selectionStart ?? box.value.length;
    setCaret(at);
    // Away from the dismissed mention: the next one opens again. (An update
    // function: a select event can follow Esc within the same render.)
    const start = activeMention(box.value, at)?.start;
    setDismissed((d) => (d === start ? d : null));
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onTextChange(e.target.value);
    track(e.target);
  };

  const onSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) =>
    track(e.currentTarget);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing || e.keyCode === 229) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      // Not the panel or dialog around the box: only the list closes.
      e.stopPropagation();
      setDismissed(mention.start);
      return true;
    }
    if (!listOpen) return false;
    const move = (by: number) => {
      e.preventDefault();
      setHighlight({
        key,
        index: (index + by + matches.length) % matches.length,
      });
      return true;
    };
    if (e.key === "ArrowDown") return move(1);
    if (e.key === "ArrowUp") return move(-1);
    if (
      (e.key === "Enter" && !e.shiftKey) ||
      (e.key === "Tab" && !e.shiftKey)
    ) {
      const match = matches[index];
      if (!match) return false;
      e.preventDefault();
      pick(match);
      return true;
    }
    return false;
  };

  const optionId = (i: number) => `${listId}-${i}`;
  const inputProps = {
    "aria-autocomplete": "list" as const,
    "aria-controls": listOpen ? listId : undefined,
    "aria-activedescendant": listOpen ? optionId(index) : undefined,
  };

  const popover = (
    <Popover.Root
      open={open}
      modal={false}
      onOpenChange={(next, details) => {
        // A press outside the box and the list closes it; Esc is handled by
        // the box (it must not close during an IME composition).
        if (next || details.reason !== "outside-press" || !mention) return;
        const target = details.event?.target;
        if (target instanceof Node && textareaRef.current?.contains(target)) {
          return;
        }
        setDismissed(mention.start);
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={textareaRef}
          side="bottom"
          align="start"
          sideOffset={4}
          className="isolate z-50"
        >
          <Popover.Popup
            role="presentation"
            initialFocus={false}
            finalFocus={false}
            className="max-h-(--available-height) w-72 max-w-(--available-width) overflow-y-auto rounded-md bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden"
          >
            {listOpen ? (
              <div
                id={listId}
                role="listbox"
                data-slot="mention-list"
                aria-label={t("mentionList")}
              >
                {matches.map((match, i) => (
                  <div
                    key={match.id}
                    id={optionId(i)}
                    role="option"
                    // Focus stays in the box (aria-activedescendant).
                    tabIndex={-1}
                    aria-selected={i === index}
                    data-highlighted={i === index ? "" : undefined}
                    // Keeps the focus (and caret) in the box.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => {
                      if (i !== index) setHighlight({ key, index: i });
                    }}
                    onClick={() => pick(match)}
                    className="flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
                  >
                    {match.kind === "project" ? (
                      <FolderKanban
                        className="text-muted-foreground"
                        aria-hidden
                      />
                    ) : (
                      <Server className="text-muted-foreground" aria-hidden />
                    )}
                    <span className="truncate">{match.label}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p role="status" className="px-2 py-1.5 text-muted-foreground">
                {t("mentionEmpty")}
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );

  return { onChange, onSelect, onKeyDown, inputProps, popover };
}
