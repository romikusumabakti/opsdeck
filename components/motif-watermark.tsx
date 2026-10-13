import { type MotifSlug, motifSrc } from "@/lib/motifs";
import { cn } from "@/lib/utils";

/**
 * A faint background ornament. The motif image is only a mask; the colour is
 * the accent's --primary, so it follows the theme and the user's accent
 * without one image per colour. It owns its size, so the sign-in corners and
 * the sidebar show the ornament at the same scale. The mask hugs the box's
 * bottom-right corner — position the box and rotate/mirror it to reach other
 * corners. Decorative only.
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
        "pointer-events-none size-[min(70vw,20rem)] select-none bg-primary opacity-[0.06] dark:opacity-[0.08] print:hidden forced-colors:hidden sm:size-[min(45vw,32.5rem)]",
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
