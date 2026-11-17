/**
 * Whether a keydown in the question box should send it: a plain Enter, never
 * Shift+Enter (new line) and never while an IME composition is confirming a
 * candidate (keyCode 229 covers browsers that report the end late).
 */
export function shouldSend(e: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode?: number;
}): boolean {
  return (
    e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229
  );
}

/**
 * Whether an edit of the question box typed an `@` that opens the context
 * picker: one `@` inserted at the caret (`caret` is right after it), into an
 * empty box or after whitespace. Inside a word (an e-mail address), in front
 * of existing text, or pasted along with other text, it stays text.
 */
export function opensContextPicker(
  prev: string,
  next: string,
  caret: number
): boolean {
  if (next.length !== prev.length + 1 || next[caret - 1] !== "@") return false;
  if (next.slice(0, caret - 1) + next.slice(caret) !== prev) return false;
  if (caret === 1) return prev === "";
  return /\s/.test(next[caret - 2] ?? "");
}
