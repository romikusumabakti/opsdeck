import { z } from "zod";
import { BRAND_ICON_SRC, type BrandName, brand } from "@/lib/branding";

/**
 * Accent colours a user can pick: shadcn/ui's seven colour themes plus
 * `neutral` (the stock black/white tokens). The choice is stored per user in
 * `users.accent_color`, set on <html data-accent> by the root layout, and
 * mapped to Tailwind palette steps in app/globals.css.
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

/** What a user gets until they choose: the brand's own colour. */
export const BRAND_DEFAULT_ACCENT: Record<BrandName, AccentColor> = {
  default: "neutral",
  dss: "blue",
};

export function isAccent(value: unknown): value is AccentColor {
  return (
    typeof value === "string" && (ACCENTS as readonly string[]).includes(value)
  );
}

export function defaultAccent(): AccentColor {
  return BRAND_DEFAULT_ACCENT[brand()];
}

/**
 * The accent to render for `user`. An unset or unknown stored value (a hand
 * edit, or a colour removed later) falls back to the brand default rather than
 * failing, like effectiveTimeZone does for zones.
 */
export function effectiveAccent(
  user: { accentColor?: string | null } | null | undefined
): AccentColor {
  const stored = user?.accentColor;
  return isAccent(stored) ? stored : defaultAccent();
}

/** Favicon URL for `accent`; no accent lets the route use the brand default. */
export function brandIconSrc(accent?: AccentColor): string {
  return accent ? `${BRAND_ICON_SRC}?accent=${accent}` : BRAND_ICON_SRC;
}
