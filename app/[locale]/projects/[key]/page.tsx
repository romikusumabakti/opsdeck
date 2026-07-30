import { notFound, redirect } from "next/navigation";
import { resolveKeySlugById } from "@/lib/env-url";

// Two generations of old links land here:
//   /projects/<uuid>  — an environment before readable URLs
//   /projects/<KEY>   — a project before it moved to the root namespace
// Both forward to their canonical location.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LegacyProjectsRedirect({
  params,
}: {
  params: Promise<{ locale: string; key: string }>;
}) {
  const { locale, key } = await params;
  if (!UUID.test(key)) {
    redirect(`/${locale}/${key.toUpperCase()}`);
  }
  const parts = await resolveKeySlugById(key);
  if (!parts) notFound();
  redirect(`/${locale}/${parts.projectKey}/${parts.envSlug}`);
}
