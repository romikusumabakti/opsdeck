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
