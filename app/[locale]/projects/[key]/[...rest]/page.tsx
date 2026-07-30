import { notFound, redirect } from "next/navigation";
import { resolveKeySlugById } from "@/lib/env-url";

// Deep legacy links: `/projects/<uuid>/services` (pre-readable-URL environment
// pages) and `/projects/<KEY>/issues/42` (project pages before they moved to
// the root namespace). Both keep working through this shim.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LegacyProjectsSubRedirect({
  params,
}: {
  params: Promise<{ locale: string; key: string; rest: string[] }>;
}) {
  const { locale, key, rest } = await params;
  const tail = rest.join("/");
  if (!UUID.test(key)) {
    redirect(`/${locale}/${key.toUpperCase()}/${tail}`);
  }
  const parts = await resolveKeySlugById(key);
  if (!parts) notFound();
  redirect(`/${locale}/${parts.projectKey}/${parts.envSlug}/${tail}`);
}
