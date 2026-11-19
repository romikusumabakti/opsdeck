import type { ReactElement, ReactNode } from "react";

// Shared by the Select trigger and the ghost Button of the person picker so
// both read as the same pill: the Select base adds shadow-xs, dark fill and
// h-9 via a data attribute, the Button adds font-medium; neutralised here.
// "compact" sizes to content with no resting border, for dense rows and cards;
// max-w-full only bounds the trigger by its container; in an auto-layout table
// callers also pass an absolute cap (e.g. max-w-32) so a long value truncates.
export const COMPACT_TRIGGER =
  "h-7 w-auto max-w-full gap-1.5 rounded-md border-transparent bg-transparent px-2 font-normal shadow-none hover:bg-muted data-[size=default]:h-7 dark:bg-transparent dark:hover:bg-muted";

/**
 * "cell": the compact ghost look filling a table column, so every row's
 * control is the same width; the value sits at the start, the chevron (the
 * trigger's last svg) at the end, hidden until the row is hovered or holds
 * focus (or the popup is open).
 */
export const CELL_TRIGGER = `${COMPACT_TRIGGER} w-full justify-between [&>svg:last-child]:opacity-0 in-[tr:hover]:[&>svg:last-child]:opacity-100 in-[tr:focus-within]:[&>svg:last-child]:opacity-100 data-popup-open:[&>svg:last-child]:opacity-100`;

/** Trigger looks of the inline pickers: "compact" for dense rows and cards,
 *  "cell" for table columns. */
export type PickerVariant = "default" | "compact" | "cell";

/**
 * A trigger the caller draws for a picker (the issue property chips and
 * sidebar rows): the element Base UI renders as the trigger, and what it
 * shows. Without one, each picker keeps its own trigger.
 */
export type PickerTrigger = {
  render: ReactElement;
  content: ReactNode;
};
