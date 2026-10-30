import { ALLOWED_EMAIL_DOMAIN, APP_NAME } from "../lib/branding";

// Replace `{{APP_NAME}}` / `{{EMAIL_DOMAIN}}` tokens in translation strings
// with values from the branding config. Double braces are used so the tokens
// don't collide with ICU's single-brace placeholders (`{name}`).
export function applyBranding<T>(value: T): T {
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
