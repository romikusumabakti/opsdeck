import { setRequestLocale } from "next-intl/server";
import { recordEnvironmentAccess } from "@/actions/environments";
import { ProjectRoleProvider } from "@/components/project-role";
import { requireProjectPage } from "@/lib/authz";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";

export default async function Layout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string; projectKey: string; envSlug: string }>;
}>) {
  const { locale, projectKey, envSlug } = await params;
  const environmentId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  setRequestLocale(locale);

  // 404 when the environment's project is invisible to the caller; otherwise the
  // effective role feeds the buttons below. Server actions enforce it regardless.
  const { role } = await requireProjectPage({ environmentId });

  // Environment confirmed to exist (requireProjectPage 404s otherwise) — bump its recency for this user so
  // the header switcher lists it first. Runs on segment entry, not on client
  // nav between sibling pages, which matches "opened this environment".
  await recordEnvironmentAccess(environmentId);

  return <ProjectRoleProvider role={role}>{children}</ProjectRoleProvider>;
}
