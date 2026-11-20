import type { ReactNode } from "react";
import { useTranslations } from "use-intl";
import { logoTiles } from "@/lib/brand-logos";
import { cn } from "@/lib/utils";
import { useBootstrap } from "@/web/api/session";

/** The instance's uploaded logo (bootstrap `logo`); null = the built-in mark. */
export type BrandLogoSource = { src: string; darkSrc: string | null } | null;

/**
 * The instance logo in a 32px box: the box matches the sidebar's collapsed
 * icon button, and the 24px mark inside it stays on its whole-pixel grid.
 * Decorative: the app name is always beside it or in a tooltip.
 *
 * With no uploaded logo it is the built-in Menara mark, inline so it takes
 * the accent's colours (--logo and --logo-status, set per accent in
 * web/styles.css) and animates (motion under `.brand-logo` there); `active`
 * makes its status tile pulse. An uploaded logo is shown as uploaded, its
 * dark variant in dark mode; `active` adds a pulsing corner dot labelled
 * `runsLabel`. Set `active` while runs are in progress.
 */
export function BrandLogoView({
  logo,
  active = false,
  className,
  runsLabel,
}: {
  logo: BrandLogoSource;
  active?: boolean;
  className?: string;
  runsLabel?: string;
}) {
  return (
    <span
      className={cn(
        "brand-logo grid size-8 shrink-0 place-items-center",
        logo && "relative",
        className
      )}
      data-active={active || undefined}
    >
      {logo ? (
        <>
          <img
            src={logo.src}
            alt=""
            draggable={false}
            className={cn(
              "size-6 object-contain",
              logo.darkSrc && "dark:hidden"
            )}
          />
          {logo.darkSrc ? (
            <img
              src={logo.darkSrc}
              alt=""
              draggable={false}
              className="hidden size-6 object-contain dark:block"
            />
          ) : null}
          {active ? (
            <span
              data-slot="brand-activity"
              role="status"
              aria-label={runsLabel}
              className="brand-activity absolute end-0.5 bottom-0.5 size-2 rounded-full bg-primary ring-2 ring-background"
            />
          ) : null}
        </>
      ) : (
        <DefaultMark />
      )}
    </span>
  );
}

function DefaultMark() {
  const tiles = logoTiles();
  return (
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
  );
}

/** The instance logo from /api/bootstrap (see BrandLogoView). */
export function BrandLogo({
  active = false,
  className,
}: {
  active?: boolean;
  className?: string;
}) {
  const { logo } = useBootstrap();
  const t = useTranslations("app");
  return (
    <BrandLogoView
      logo={logo}
      active={active}
      className={className}
      runsLabel={t("runsInProgress")}
    />
  );
}

/** The sign-in lockup's layout: the logo plus the wordmark. */
export function BrandLockup({
  logo,
  name,
  className,
}: {
  logo: ReactNode;
  name: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {logo}
      <span className="text-base font-semibold tracking-tight">{name}</span>
    </div>
  );
}

/** Lockup used on the unauthenticated pages: the logo plus the wordmark. */
export function BrandMark({ className }: { className?: string }) {
  const { appName } = useBootstrap();
  return (
    <BrandLockup logo={<BrandLogo />} name={appName} className={className} />
  );
}
