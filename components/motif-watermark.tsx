import { type MotifSlug, motifSrc } from "@/lib/motifs";
import { cn } from "@/lib/utils";

/**
 * A faint background ornament. The motif image is only a mask; the colour is
 * the accent's --primary, so it follows the theme and the user's accent
 * without one image per colour. It owns its size, so the sign-in corners and
 * the sidebar show the ornament at the same scale. The size is capped by the
 * viewport height too, so short screens don't fill up with ornament. The mask hugs the box's
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
        "pointer-events-none size-[min(60vw,14rem)] select-none bg-primary opacity-[0.06] dark:opacity-[0.08] print:hidden forced-colors:hidden sm:size-[min(36vw,60vh,26rem)]",
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
