export const locales = ["ar", "en", "id", "zh"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

export const localeLabels: Record<Locale, string> = {
  id: "Bahasa Indonesia",
  en: "English",
  zh: "中文",
  ar: "العربية",
};

export const rtlLocales: ReadonlySet<Locale> = new Set(["ar"]);

export function isRtlLocale(locale: Locale): boolean {
  return rtlLocales.has(locale);
}
