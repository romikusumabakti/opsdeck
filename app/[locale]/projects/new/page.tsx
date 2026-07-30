import { redirect } from "next/navigation";

// Creating a deployment moved to /environments/new when "project" (the old name
// for a deployment) became "environment". Old links land here; forward them,
// query string included, so bookmarked clone/preselect URLs keep working.
export default async function LegacyNewEnvironmentRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ locale }, search] = await Promise.all([params, searchParams]);
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string") qs.set(key, value);
    else if (Array.isArray(value)) for (const v of value) qs.append(key, v);
  }
  const suffix = qs.size > 0 ? `?${qs.toString()}` : "";
  redirect(`/${locale}/environments/new${suffix}`);
}
