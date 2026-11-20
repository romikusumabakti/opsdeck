import { z } from "zod";

/**
 * Accent colours a user can pick: shadcn/ui's seven colour themes plus
 * `neutral` (the stock black/white tokens). The choice is stored per user in
 * `users.accent_color`, set on <html data-accent> by the root layout, and
 * mapped to Tailwind palette steps in web/styles.css.
 */
export const ACCENTS = [
  "neutral",
  "blue",
  "green",
  "orange",
  "red",
  "rose",
  "violet",
  "yellow",
] as const;
export type AccentColor = (typeof ACCENTS)[number];

export const accentSchema = z.enum(ACCENTS);

export function isAccent(value: unknown): value is AccentColor {
  return (
    typeof value === "string" && (ACCENTS as readonly string[]).includes(value)
  );
}

/**
 * The accent to render for `user`. An unset or unknown stored value (a hand
 * edit, or a colour removed later) falls back to the instance accent (Admin ›
 * Instance › Branding; the SPA has it from /api/bootstrap) rather than
 * failing, like effectiveTimeZone does for zones.
 */
export function effectiveAccent(
  user: { accentColor?: string | null } | null | undefined,
  instanceAccent: AccentColor
): AccentColor {
  const stored = user?.accentColor;
  return isAccent(stored) ? stored : instanceAccent;
}

/** The built-in favicon, rendered per accent by server/routes/brand.ts. */
export const BRAND_ICON_SRC = "/brand/icon.svg";

/**
 * The favicon as /api/bootstrap describes it: the built-in mark
 * (`custom: false`), or the instance's uploaded logo (its SVG, or a PNG
 * rendered from a raster logo), versioned so a new upload is fetched.
 */
export type BootstrapIcon = {
  src: string;
  type: "image/svg+xml" | "image/png";
  custom: boolean;
};

/**
 * Favicon URL for `icon` painted in `accent`. Only the built-in mark takes
 * the accent; an uploaded logo is shown as uploaded. No accent lets the route
 * use the instance accent.
 */
export function brandIconSrc(
  icon: BootstrapIcon,
  accent?: AccentColor
): string {
  return accent && !icon.custom ? `${icon.src}?accent=${accent}` : icon.src;
}
