import { getTranslations, setRequestLocale } from "next-intl/server";
import { getInvitationByToken } from "@/actions/users";
import { AuthShell } from "@/components/auth-shell";
import { AcceptInviteForm } from "./accept-invite-form";

export default async function AcceptInvitePage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  const inv = await getInvitationByToken(token);
  const t = await getTranslations("acceptInvite");

  if (!inv) {
    return (
      <AuthShell
        title={t("invalidTitle")}
        description={t("invalidDescription")}
      />
    );
  }

  return (
    <AuthShell
      title={t("title")}
      description={t("description", { email: inv.email })}
    >
      <AcceptInviteForm token={token} email={inv.email} name={inv.name} />
    </AuthShell>
  );
}
