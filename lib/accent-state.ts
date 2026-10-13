import type { AccentColor } from "@/lib/accents";

/**
 * What the picker should show at each stage of a change: the requested
 * accent at once (optimistic), kept when the save succeeds, and the previous
 * one restored when it fails. `null` means nothing to do.
 */
export function nextAccentState(
  current: AccentColor,
  requested: AccentColor,
  outcome: "pending" | "saved" | "failed"
): { apply: AccentColor; rollbackTo: AccentColor | null } | null {
  if (requested === current && outcome === "pending") return null;
  if (outcome === "pending") return { apply: requested, rollbackTo: current };
  if (outcome === "saved") return { apply: requested, rollbackTo: null };
  return { apply: current, rollbackTo: null };
}
