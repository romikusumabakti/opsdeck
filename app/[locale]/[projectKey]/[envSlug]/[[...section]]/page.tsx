import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { requireSession } from "@/lib/auth-session";
import { db } from "@/lib/db";
import { environments } from "@/lib/db/schema";

// Stage 2 of the key/slug URL migration. Readable environment URLs
// (`/CMEM/prod/databases`) resolve here and redirect to the canonical
// `/projects/[envId]/…` route. Keys are always uppercase (projectKeySchema) and
// every app route is lowercase, and path matching is case-sensitive — so this
// dynamic segment can never shadow a static top-level route (/issues, etc.).
// A later stage flips the canonical location so the readable URL renders in
// place instead of redirecting.
export default async function EnvUrlResolver({
  params,
}: {
  params: Promise<{
    locale: string;
    projectKey: string;
    envSlug: string;
    section?: string[];
  }>;
}) {
  const { locale, projectKey, envSlug, section } = await params;
  setRequestLocale(locale);
  await requireSession();

  const project = await db.query.projects.findFirst({
    where: { key: projectKey.toUpperCase() },
    columns: { id: true },
  });
  if (!project) notFound();

  const [env] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(
      and(
        eq(environments.projectId, project.id),
        eq(environments.slug, envSlug.toLowerCase())
      )
    )
    .limit(1);
  if (!env) notFound();

  const rest = section?.length ? `/${section.join("/")}` : "";
  redirect(`/projects/${env.id}${rest}`);
}
