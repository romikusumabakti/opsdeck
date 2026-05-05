import { getInvitationByToken } from "@/actions/users";
import { AcceptInviteForm } from "./accept-invite-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Aperture } from "lucide-react";
import { getTranslations } from "next-intl/server";

export default async function AcceptInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const inv = await getInvitationByToken(token);
  const t = await getTranslations("acceptInvite");
  const tApp = await getTranslations("app");

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2 mb-2">
            <Aperture />
            <span className="font-bold">{tApp("name")}</span>
          </div>
          {inv ? (
            <>
              <CardTitle>{t("title")}</CardTitle>
              <CardDescription>
                {t("description", { email: inv.email })}
              </CardDescription>
            </>
          ) : (
            <>
              <CardTitle>{t("invalidTitle")}</CardTitle>
              <CardDescription>{t("invalidDescription")}</CardDescription>
            </>
          )}
        </CardHeader>
        {inv && (
          <CardContent>
            <AcceptInviteForm
              token={token}
              email={inv.email}
              name={inv.name}
            />
          </CardContent>
        )}
      </Card>
    </div>
  );
}
