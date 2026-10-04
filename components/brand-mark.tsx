import Image from "next/image";
import { APP_NAME, BRAND_LOGO_SRC } from "@/lib/branding";
import { cn } from "@/lib/utils";

/**
 * The deployment's logo on its own. Decorative (`alt=""`): wherever it appears
 * the app name sits beside it or in a tooltip. `unoptimized` because the image
 * optimizer refuses SVG, and a vector needs no resizing anyway. Eager because
 * it always sits at the top of the page.
 */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <Image
      src={BRAND_LOGO_SRC}
      alt=""
      width={32}
      height={32}
      unoptimized
      loading="eager"
      className={cn("size-8 shrink-0", className)}
    />
  );
}

/** Lockup used on the unauthenticated pages: the logo plus the wordmark. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <BrandLogo className="size-9" />
      <span className="text-base font-semibold tracking-tight">{APP_NAME}</span>
    </div>
  );
}
