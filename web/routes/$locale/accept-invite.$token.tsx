import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { AuthShell } from "@/components/auth-shell";
import { getInvitationByTokenQuery } from "@/web/api/users";
import { AcceptInviteForm } from "./-components/accept-invite-form";

export const Route = createFileRoute("/$locale/accept-invite/$token")({
  loader: async ({ params: { token }, context: { queryClient } }) => {
    await queryClient.query(getInvitationByTokenQuery(token));
  },
  component: AcceptInvitePage,
});

function AcceptInvitePage() {
  const t = useTranslations("acceptInvite");
  const { token } = Route.useParams();
  const invitation = useSuspenseQuery(getInvitationByTokenQuery(token)).data;

  if (!invitation) {
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
      description={t("description", { email: invitation.email })}
    >
      <AcceptInviteForm
        token={token}
        email={invitation.email}
        name={invitation.name}
      />
    </AuthShell>
  );
}
