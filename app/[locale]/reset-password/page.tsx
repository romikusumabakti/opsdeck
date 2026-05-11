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
import { Link, redirect } from "@/i18n/navigation";
import { getServerSession } from "@/lib/auth-session";
import { ResetPasswordForm } from "./reset-password-form";

export default async function ResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { locale } = await params;
  const { token, error } = await searchParams;
  setRequestLocale(locale);

  const session = await getServerSession();
  if (session) {
    await redirect("/");
  }

  const t = await getTranslations("resetPassword");
  const tApp = await getTranslations("app");

  const invalid = !token || error === "INVALID_TOKEN";

  return (
    <div className="min-h-screen flex flex-col p-4">
      <div className="flex-1 flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="flex items-center gap-2 mb-2">
              <Aperture />
              <span className="font-bold">{tApp("name")}</span>
            </div>
            {invalid ? (
              <>
                <CardTitle>{t("invalidTitle")}</CardTitle>
                <CardDescription>{t("invalidDescription")}</CardDescription>
              </>
            ) : (
              <>
                <CardTitle>{t("title")}</CardTitle>
                <CardDescription>{t("description")}</CardDescription>
              </>
            )}
          </CardHeader>
          <CardContent>
            {invalid ? (
              <Link
                href="/forgot-password"
                className="text-sm underline hover:no-underline"
              >
                {t("requestAgain")}
              </Link>
            ) : (
              <ResetPasswordForm token={token} />
            )}
          </CardContent>
        </Card>
      </div>
      <Copyright className="pt-4" />
    </div>
  );
}
