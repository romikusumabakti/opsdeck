import { useTranslations } from "use-intl";
import {
  BrandLockup,
  type BrandLogoSource,
  BrandLogoView,
} from "@/components/brand-mark";
import type { AccentColor } from "@/lib/accents";

/**
 * The Branding tab's live preview: the sidebar header and the sign-in
 * header, side by side, as they will look with `name`, `accent` and `logo`.
 * `data-accent` re-themes this subtree only (web/styles.css re-declares the
 * tokens for a nested accent, neutral included), so the admin's own accent
 * on <html> doesn't leak in.
 */
export function BrandPreview({
  name,
  accent,
  logo,
}: {
  name: string;
  accent: AccentColor;
  logo: BrandLogoSource;
}) {
  const t = useTranslations("instance.branding");
  return (
    <div
      data-slot="brand-preview"
      data-accent={accent}
      className="grid gap-4 sm:grid-cols-2"
    >
      <figure className="flex flex-col gap-2">
        <figcaption className="text-xs text-muted-foreground">
          {t("previewSidebar")}
        </figcaption>
        {/* SidebarHeader + a size="lg" SidebarMenuButton (components/ui/sidebar). */}
        <div
          data-slot="brand-preview-header"
          className="flex h-16 items-center rounded-lg border bg-sidebar p-2 text-sidebar-foreground"
        >
          <div className="flex h-12 min-w-0 flex-1 items-center gap-2 p-2 text-sm">
            <BrandLogoView logo={logo} />
            <span className="truncate font-semibold">{name}</span>
          </div>
        </div>
      </figure>
      <figure className="flex flex-col gap-2">
        <figcaption className="text-xs text-muted-foreground">
          {t("previewSignIn")}
        </figcaption>
        <div
          data-slot="brand-preview-header"
          className="flex h-16 items-center justify-center rounded-lg border bg-background p-2 text-foreground"
        >
          <BrandLockup
            logo={<BrandLogoView logo={logo} />}
            name={name}
            className="min-w-0"
          />
        </div>
      </figure>
    </div>
  );
}
