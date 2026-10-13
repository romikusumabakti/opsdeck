import { type MotifSlug, motifSrc } from "@/lib/motifs";
import { cn } from "@/lib/utils";

/**
 * A faint background ornament. The motif image is only a mask; the colour is
 * the accent's --primary, so it follows the theme and the user's accent
 * without one image per colour. The mask hugs the bottom-right corner of the
 * box — rotate or mirror the box to put it in another corner. Decorative only.
 */
export function MotifWatermark({
  slug,
  className,
}: {
  slug: MotifSlug;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none select-none bg-primary opacity-[0.06] dark:opacity-[0.08] print:hidden forced-colors:hidden",
        className
      )}
      style={{
        maskImage: `url(${motifSrc(slug)})`,
        maskRepeat: "no-repeat",
        maskSize: "contain",
        maskPosition: "bottom right",
      }}
    />
  );
}
