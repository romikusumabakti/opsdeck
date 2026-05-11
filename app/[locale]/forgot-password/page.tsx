import { Aperture } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Copyright } from "@/components/copyright";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { redirect } from "@/i18n/navigation";
import { getServerSession } from "@/lib/auth-session";
import { ForgotPasswordForm } from "./forgot-password-form";

export default async function ForgotPasswordPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await getServerSession();
  if (session) {
    await redirect("/");
  }

  const t = await getTranslations("forgotPassword");
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
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ForgotPasswordForm />
          </CardContent>
        </Card>
      </div>
      <Copyright className="pt-4" />
    </div>
  );
}
