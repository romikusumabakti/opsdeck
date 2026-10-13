import type { AccentColor } from "@/lib/accents";
import { cn } from "@/lib/utils";

// Literal classes so Tailwind's scanner emits them: each accent's primary step
// (900 light / 300 dark), matching the button colour it will produce.
const DOT: Record<AccentColor, string> = {
  neutral: "bg-neutral-900 dark:bg-neutral-100",
  blue: "bg-blue-900 dark:bg-blue-300",
  green: "bg-green-900 dark:bg-green-300",
  orange: "bg-orange-900 dark:bg-orange-300",
  red: "bg-red-900 dark:bg-red-300",
  rose: "bg-rose-900 dark:bg-rose-300",
  violet: "bg-violet-900 dark:bg-violet-300",
  yellow: "bg-yellow-900 dark:bg-yellow-300",
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
