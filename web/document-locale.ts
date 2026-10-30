import { isRtlLocale, type Locale } from "@/i18n/locales";
import { type AccentColor, brandIconSrc } from "@/lib/accents";

/**
 * Point <html> at the locale being read: `lang` for screen readers and
 * hyphenation, `dir` for the layout direction (and, via styles.css, the
 * Arabic font). Under Next the server rendered both into the document; the SPA
 * sets them whenever the locale changes, so a switch needs no reload.
 */
export function applyDocumentLocale(locale: Locale): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = isRtlLocale(locale) ? "rtl" : "ltr";
}

/**
 * Paint the page and the favicon in `accent`: `data-accent` on <html> selects
 * the palette in web/styles.css, and the icon is rendered per accent by
 * server/routes/brand.ts.
 */
export function applyDocumentAccent(accent: AccentColor): void {
  document.documentElement.dataset.accent = accent;
  for (const link of document.querySelectorAll<HTMLLinkElement>(
    'link[rel="icon"]'
  )) {
    link.href = brandIconSrc(accent);
  }
}
