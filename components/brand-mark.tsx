import { BRAND_LOGO_DEFS, logoTiles } from "@/lib/brand-logos";
import { APP_NAME, type BrandName } from "@/lib/branding";
import { cn } from "@/lib/utils";

/**
 * The deployment's logo, inline so it can take the theme's colours and animate
 * (motion lives in globals.css under `.brand-logo`). A 24px mark centred in a
 * 32px box: the box matches the sidebar's collapsed icon button, and the mark
 * stays on its whole-pixel grid. Decorative (`aria-hidden`): the app name is
 * always beside it or in a tooltip.
 *
 * `logo` comes from `brand()`, read on the server and passed down.
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
  const { fill } = BRAND_LOGO_DEFS[logo];
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
        <path
          className={cn("brand-tile brand-tile-tl", fill.fg)}
          d={tiles.tl}
        />
        <path
          className={cn("brand-tile brand-tile-bl", fill.fg)}
          d={tiles.bl}
        />
        <path
          className={cn("brand-tile brand-tile-tr", fill.fg)}
          d={tiles.tr}
        />
        <path
          className={cn("brand-tile brand-tile-br", fill.status)}
          d={tiles.br}
        />
      </svg>
    </span>
  );
}

/** Lockup used on the unauthenticated pages: the logo plus the wordmark. */
export function BrandMark({
  logo,
  className,
}: {
  logo: BrandName;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <BrandLogo logo={logo} />
      <span className="text-base font-semibold tracking-tight">{APP_NAME}</span>
    </div>
  );
}
