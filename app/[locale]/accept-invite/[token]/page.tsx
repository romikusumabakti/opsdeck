import { Aperture } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getInvitationByToken } from "@/actions/users";
import { Copyright } from "@/components/copyright";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  const tApp = await getTranslations("app");

  return (
    <div className="min-h-screen flex flex-col p-4">
      <div className="flex-1 flex items-center justify-center">
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
      <Copyright className="pt-4" />
    </div>
  );
}
