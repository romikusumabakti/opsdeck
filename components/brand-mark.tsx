import { Aperture } from "lucide-react";
import { APP_NAME } from "@/lib/branding";
import { cn } from "@/lib/utils";

/**
 * Lockup used on the unauthenticated pages: a filled mark plus the wordmark.
 * A bare outline icon next to bold text reads as a stray glyph rather than a
 * logo, so the mark gets its own container to give it weight.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
        <Aperture className="size-5" aria-hidden="true" />
      </span>
      <span className="text-base font-semibold tracking-tight">{APP_NAME}</span>
    </div>
  );
}
