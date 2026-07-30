import { getTranslations, setRequestLocale } from "next-intl/server";
import {
  getEnvironmentById,
  recordEnvironmentAccess,
} from "@/actions/environments";
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
  const environmentId = await resolveEnvIdByKeySlug(projectKey, envSlug);
  setRequestLocale(locale);

  const environment = await getEnvironmentById(environmentId);

  if (!environment) {
    const tCommon = await getTranslations("common");
    return <p>{tCommon("environmentNotFound")}</p>;
  }

  // Environment confirmed to exist (valid FK) — bump its recency for this user so
  // the header switcher lists it first. Runs on segment entry, not on client
  // nav between sibling pages, which matches "opened this environment".
  await recordEnvironmentAccess(environmentId);

  // `environmentId` is an environment id here; resolve the effective role for its
  // owning environment so ops buttons below can disable themselves for users who
  // lack the destructive-ops capability. Server actions enforce this regardless.
  const canRunOps = roleHasCapability(
    await getEffectiveRole({ environmentId: environmentId }),
    "ops.destructive"
  );

  return (
    <OpsCapabilityProvider canRunOps={canRunOps}>
      {children}
    </OpsCapabilityProvider>
  );
}
