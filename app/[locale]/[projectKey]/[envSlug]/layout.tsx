import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById, recordProjectAccess } from "@/actions/projects";
import { OpsCapabilityProvider } from "@/components/ops-capability";
import { getEffectiveRole } from "@/lib/auth-session";
import { resolveEnvIdByKeySlug } from "@/lib/env-url";
import { roleHasCapability } from "@/lib/roles";

export default async function Layout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string; projectKey: string; envSlug: string }>;
}>) {
  const { locale, projectKey, envSlug } = await params;
  const projectId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  setRequestLocale(locale);

  const project = await getProjectById(projectId);

  if (!project) {
    const tCommon = await getTranslations("common");
    return <p>{tCommon("projectNotFound")}</p>;
  }

  // Project confirmed to exist (valid FK) — bump its recency for this user so
  // the header switcher lists it first. Runs on segment entry, not on client
  // nav between sibling pages, which matches "opened this project".
  await recordProjectAccess(projectId);

  // `projectId` is an environment id here; resolve the effective role for its
  // owning project so ops buttons below can disable themselves for users who
  // lack the destructive-ops capability. Server actions enforce this regardless.
  const canRunOps = roleHasCapability(
    await getEffectiveRole({ environmentId: projectId }),
    "ops.destructive"
  );

  return (
    <OpsCapabilityProvider canRunOps={canRunOps}>
      {children}
    </OpsCapabilityProvider>
  );
}
