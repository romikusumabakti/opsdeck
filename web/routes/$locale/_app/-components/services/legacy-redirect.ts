import type { Locale } from "@/i18n/locales";
import { redirect } from "@/i18n/navigation";
import { resolveLegacyApp } from "@/web/api/service-catalog";

// Old app URLs (`/admin/repositories/<appKey>…`, `/apps/<appKey>…`) from
// before Stage 8's services model: a one-service app leads to that service,
// a multi-service one to the Services list filtered by its repositories,
// anything else to the list.

/** Where an old app URL leads, given the app's services. */
export function legacyServicesHref(
  services: readonly { key: string; repoFullName: string }[]
): string {
  const [only] = services;
  if (services.length === 1 && only) {
    return `/admin/services/${encodeURIComponent(only.key)}`;
  }
  if (services.length === 0) return "/admin/services";
  const repos = [...new Set(services.map((s) => s.repoFullName))].sort();
  const query = new URLSearchParams(repos.map((repo) => ["repo", repo]));
  return `/admin/services?${query}`;
}

/** The services an old app key stands for; none when the lookup fails. */
export async function legacyAppServices(
  appKey: string
): Promise<{ key: string; repoFullName: string }[]> {
  try {
    return (await resolveLegacyApp(appKey)).services;
  } catch {
    return [];
  }
}

/** A route hook for an old app URL: redirects to where it leads now. */
export async function redirectLegacyApp({
  params: { locale, appKey },
}: {
  params: { locale: Locale; appKey: string };
}): Promise<never> {
  redirect(legacyServicesHref(await legacyAppServices(appKey)), locale);
}
