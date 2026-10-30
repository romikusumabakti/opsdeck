import type { Locale } from "@/i18n/locales";

// The messages are untyped JSON. This is use-intl's own `IntlMessages` shape;
// its stricter `AbstractIntlMessages` makes the translator's key-inference
// collapse to `never` when there is no typed message catalogue to infer from.
// biome-ignore lint/suspicious/noExplicitAny: matches use-intl's IntlMessages
export type Messages = Record<string, any>;

/**
 * A locale's catalogue. The template import makes Vite emit one chunk per
 * locale, so a reader downloads only their own language.
 */
export async function loadCatalogue(locale: Locale): Promise<Messages> {
  const module = (await import(`../messages/${locale}.json`)) as {
    default: Messages;
  };
  return module.default;
}
