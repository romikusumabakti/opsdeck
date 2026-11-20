// Replace `{{APP_NAME}}` / `{{COMPANY_NAME}}` / `{{EMAIL_DOMAIN}}` tokens in
// translation strings with the instance's branding. Double braces are used so
// the tokens don't collide with ICU's single-brace placeholders (`{name}`).
// `{{COMPANY_NAME}}` falls back to the instance name when no company is set.
//
// The values are passed in: the server reads them from the stored branding
// (lib/instance-branding), the SPA gets them from `/api/bootstrap`, and this
// module runs in both.

export type Branding = {
  appName: string;
  companyName: string | null;
  allowedEmailDomain: string;
};

export function applyBranding<T>(value: T, branding: Branding): T {
  if (typeof value === "string") {
    return value
      .replaceAll("{{APP_NAME}}", branding.appName)
      .replaceAll("{{COMPANY_NAME}}", branding.companyName ?? branding.appName)
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
