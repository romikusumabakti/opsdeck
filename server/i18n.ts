import { createTranslator, type TranslationValues } from "use-intl/core";
import { applyBranding } from "@/i18n/branding";
import type { Locale } from "@/i18n/locales";
import { ALLOWED_EMAIL_DOMAIN } from "@/lib/branding";
import { getBranding, type InstanceBranding } from "@/lib/instance-branding";
import { effectiveTimeZone } from "@/lib/timezone";
import { getLocale, getServerSession } from "@/server/context";

// Server-side translations for text the server writes itself — emails,
// notifications, error messages — in place of next-intl's `getTranslations`.

// The messages are untyped JSON. This is use-intl's own `IntlMessages` shape;
// its stricter `AbstractIntlMessages` makes the translator's key-inference
// collapse to `never` when there is no typed message catalogue to infer from.
// biome-ignore lint/suspicious/noExplicitAny: matches use-intl's IntlMessages
type Messages = Record<string, any>;

// Each locale's messages are branded once per branding version rather than
// walked on every call; a new version (an admin's save) drops them all. The
// key carries the values too: the env fallback after a failed load shares
// version "0" with a never-saved branding.
let brandedKey: string | null = null;
const brandedMessages = new Map<Locale, Promise<Messages>>();

// One literal import per locale rather than a template `import()`: `bun build`
// bundles only specifiers it can see, and the Record makes a new locale a type
// error here until its catalogue is listed.
const catalogues: Record<Locale, () => Promise<{ default: unknown }>> = {
  ar: () => import("../messages/ar.json"),
  en: () => import("../messages/en.json"),
  es: () => import("../messages/es.json"),
  id: () => import("../messages/id.json"),
  zh: () => import("../messages/zh.json"),
};

function loadMessages(
  locale: Locale,
  branding: InstanceBranding
): Promise<Messages> {
  const key = JSON.stringify([
    branding.version,
    branding.name,
    branding.company,
  ]);
  if (key !== brandedKey) {
    brandedMessages.clear();
    brandedKey = key;
  }
  let messages = brandedMessages.get(locale);
  if (!messages) {
    messages = catalogues[locale]().then((module) =>
      applyBranding(module.default as Messages, {
        appName: branding.name,
        companyName: branding.company,
        allowedEmailDomain: ALLOWED_EMAIL_DOMAIN,
      })
    );
    brandedMessages.set(locale, messages);
  }
  return messages;
}

/**
 * A translator for the request's locale, optionally scoped to a namespace
 * (`t("title")` instead of `t("issues.title")`). Dates format in the reader's
 * own time zone, as they did under next-intl's request config; outside a
 * request that is the default locale and the app time zone.
 */
export async function getServerTranslator(
  namespace?: string
): Promise<(key: string, values?: TranslationValues) => string> {
  const locale = getLocale();
  const [messages, session] = await Promise.all([
    getBranding().then((branding) => loadMessages(locale, branding)),
    getServerSession(),
  ]);
  const t = createTranslator({
    locale,
    messages,
    namespace,
    timeZone: effectiveTimeZone(session?.user),
  });
  return (key, values) => t(key, values);
}
