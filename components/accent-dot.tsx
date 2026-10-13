import type { AccentColor } from "@/lib/accents";
import { cn } from "@/lib/utils";

// Literal classes so Tailwind's scanner emits them. A swatch names the hue,
// not the exact button colour: the buttons' step 900 (light) is too dark at
// 12px to tell orange, red and yellow apart, so swatches use each family's
// most saturated step, 600, and 500 on dark menus. Neutral stays black/white.
const DOT: Record<AccentColor, string> = {
  neutral: "bg-neutral-900 dark:bg-neutral-100",
  blue: "bg-blue-600 dark:bg-blue-500",
  green: "bg-green-600 dark:bg-green-500",
  orange: "bg-orange-600 dark:bg-orange-500",
  red: "bg-red-600 dark:bg-red-500",
  rose: "bg-rose-600 dark:bg-rose-500",
  violet: "bg-violet-600 dark:bg-violet-500",
  yellow: "bg-yellow-600 dark:bg-yellow-500",
};

/** A small swatch for an accent; decorative, the name is always beside it. */
export function AccentDot({
  accent,
  className,
}: {
  accent: AccentColor;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-3 shrink-0 rounded-full ring-1 ring-border",
        DOT[accent],
        className
      )}
    />
  );
}
