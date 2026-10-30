import type { AccentColor } from "@/lib/accents";

export type TintedAccent = Exclude<AccentColor, "neutral">;
type Steps = {
  logoLight: number;
  logoDark: number;
  ringLight: number;
  ringDark: number;
};

/**
 * Tailwind steps per accent for the logo and focus ring. Logo: 900 light, 200
 * dark. Ring: 500 light and 400 dark, except where that falls below 3:1
 * against the page background (WCAG 1.4.11): green and orange use 600, yellow
 * 700. web/styles.css binds the same steps; tests/accent-theme.test.ts checks
 * both agree.
 */
export const ACCENT_STEPS: Record<TintedAccent, Steps> = {
  blue: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
  green: { logoLight: 900, logoDark: 200, ringLight: 600, ringDark: 400 },
  orange: { logoLight: 900, logoDark: 200, ringLight: 600, ringDark: 400 },
  red: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
  rose: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
  violet: { logoLight: 900, logoDark: 200, ringLight: 500, ringDark: 400 },
  yellow: { logoLight: 900, logoDark: 200, ringLight: 700, ringDark: 400 },
};

/**
 * The oklch values of ACCENT_STEPS, copied from tailwindcss/theme.css for the
 * favicon (which cannot read the page's CSS variables). Kept in sync by
 * tests/accent-palette.test.ts.
 */
export const ACCENT_PALETTE: Record<
  TintedAccent,
  Record<keyof Steps, string>
> = {
  blue: {
    logoLight: "oklch(37.9% 0.146 265.522)",
    logoDark: "oklch(88.2% 0.059 254.128)",
    ringLight: "oklch(62.3% 0.214 259.815)",
    ringDark: "oklch(70.7% 0.165 254.624)",
  },
  green: {
    logoLight: "oklch(39.3% 0.095 152.535)",
    logoDark: "oklch(92.5% 0.084 155.995)",
    ringLight: "oklch(62.7% 0.194 149.214)",
    ringDark: "oklch(79.2% 0.209 151.711)",
  },
  orange: {
    logoLight: "oklch(40.8% 0.123 38.172)",
    logoDark: "oklch(90.1% 0.076 70.697)",
    ringLight: "oklch(64.6% 0.222 41.116)",
    ringDark: "oklch(75% 0.183 55.934)",
  },
  red: {
    logoLight: "oklch(39.6% 0.141 25.723)",
    logoDark: "oklch(88.5% 0.062 18.334)",
    ringLight: "oklch(63.7% 0.237 25.331)",
    ringDark: "oklch(70.4% 0.191 22.216)",
  },
  rose: {
    logoLight: "oklch(41% 0.159 10.272)",
    logoDark: "oklch(89.2% 0.058 10.001)",
    ringLight: "oklch(64.5% 0.246 16.439)",
    ringDark: "oklch(71.2% 0.194 13.428)",
  },
  violet: {
    logoLight: "oklch(38% 0.189 293.745)",
    logoDark: "oklch(89.4% 0.057 293.283)",
    ringLight: "oklch(60.6% 0.25 292.717)",
    ringDark: "oklch(70.2% 0.183 293.541)",
  },
  yellow: {
    logoLight: "oklch(42.1% 0.095 57.708)",
    logoDark: "oklch(94.5% 0.129 101.54)",
    ringLight: "oklch(55.4% 0.135 66.442)",
    ringDark: "oklch(85.2% 0.199 91.936)",
  },
};
