import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { ALLOWED_EMAIL_DOMAIN, APP_NAME } from "../lib/branding";
import { routing } from "./routing";

// Replace `{{APP_NAME}}` / `{{EMAIL_DOMAIN}}` tokens in translation strings
// with values from the branding config. Double braces are used so the tokens
// don't collide with next-intl's single-brace ICU placeholders (`{name}`).
function applyBranding<T>(value: T): T {
  if (typeof value === "string") {
    return value
      .replaceAll("{{APP_NAME}}", APP_NAME)
      .replaceAll("{{EMAIL_DOMAIN}}", ALLOWED_EMAIL_DOMAIN) as T;
  }
  if (Array.isArray(value)) {
    return value.map(applyBranding) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = applyBranding(v);
    }
    return out as T;
  }
  return value;
}

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  const raw = (await import(`../messages/${locale}.json`)).default;
  return {
    locale,
    messages: applyBranding(raw),
  };
});
