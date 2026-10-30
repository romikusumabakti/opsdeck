import { isRtlLocale, type Locale } from "@/i18n/locales";

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
