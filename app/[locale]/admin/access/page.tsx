import { setRequestLocale } from "next-intl/server";
import { getAccessMatrix } from "@/actions/access";
import { requireOrgPage } from "@/lib/authz";
import { canOrg } from "@/lib/permissions";
import { AccessClient } from "./access-client";

export default async function AccessPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireOrgPage({ audit: ["read"] });
  const matrix = await getAccessMatrix();
  return (
    <AccessClient
      matrix={matrix}
      now={new Date().toISOString()}
      selfId={session.user.id}
      canEdit={canOrg(session.user.role, { user: ["set-role"] })}
      canOffboard={canOrg(session.user.role, { user: ["offboard"] })}
    />
  );
}
