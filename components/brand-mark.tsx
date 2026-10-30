import { logoTiles } from "@/lib/brand-logos";
import type { BrandName } from "@/lib/brands";
import { cn } from "@/lib/utils";
import { useBootstrap } from "@/web/api/session";

/**
 * The deployment's logo, inline so it takes the accent's colours (--logo and
 * --logo-status, set per accent in globals.css) and animates (motion lives in
 * globals.css under `.brand-logo`). A 24px mark centred in a 32px box: the box
 * matches the sidebar's collapsed icon button, and the mark stays on its
 * whole-pixel grid. Decorative (`aria-hidden`): the app name is always beside
 * it or in a tooltip.
 *
 * `logo` (the shape) is the deployment's brand, from `/api/bootstrap`.
 * `active` makes the status tile pulse — set it while runs are in progress.
 */
export function BrandLogo({
  logo,
  active = false,
  className,
}: {
  logo: BrandName;
  active?: boolean;
  className?: string;
}) {
  const tiles = logoTiles(logo);
  return (
    <span
      className={cn(
        "brand-logo grid size-8 shrink-0 place-items-center",
        className
      )}
      data-active={active || undefined}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        // `!`: SidebarMenuButton forces every descendant svg to size-4.
        className="size-6! overflow-visible"
      >
        <path className="brand-tile brand-tile-tl fill-(--logo)" d={tiles.tl} />
        <path className="brand-tile brand-tile-bl fill-(--logo)" d={tiles.bl} />
        <path className="brand-tile brand-tile-tr fill-(--logo)" d={tiles.tr} />
        <path
          className="brand-tile brand-tile-br fill-(--logo-status)"
          d={tiles.br}
        />
      </svg>
    </span>
  );
}

/** Lockup used on the unauthenticated pages: the logo plus the wordmark. */
export function BrandMark({ className }: { className?: string }) {
  const { appName, brand } = useBootstrap();
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <BrandLogo logo={brand} />
      <span className="text-base font-semibold tracking-tight">{appName}</span>
    </div>
  );
}
