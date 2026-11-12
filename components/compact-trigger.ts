// "compact" sizes to content with no resting border, for dense rows and cards;
// max-w-full only bounds the trigger by its container; in an auto-layout table
// callers also pass an absolute cap (e.g. max-w-32) so a long value truncates.
export const COMPACT_TRIGGER =
  "h-7 w-auto max-w-full gap-1.5 border-transparent bg-transparent px-2 hover:bg-muted";
