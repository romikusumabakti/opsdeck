// Replace `{{APP_NAME}}` / `{{EMAIL_DOMAIN}}` tokens in translation strings
// with the deployment's branding. Double braces are used so the tokens don't
// collide with ICU's single-brace placeholders (`{name}`).
//
// The values are passed in rather than read from lib/branding: the server has
// them in its env, the SPA gets them from `/api/bootstrap`, and this module
// runs in both.

export type Branding = { appName: string; allowedEmailDomain: string };

export function applyBranding<T>(value: T, branding: Branding): T {
  if (typeof value === "string") {
    return value
      .replaceAll("{{APP_NAME}}", branding.appName)
      .replaceAll("{{EMAIL_DOMAIN}}", branding.allowedEmailDomain) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyBranding(item, branding)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = applyBranding(v, branding);
    }
    return out as T;
  }
  return value;
}
