import { getTranslations, setRequestLocale } from "next-intl/server";
import { ServerForm } from "@/components/server-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { redirect } from "@/i18n/navigation";
import { getServerSession } from "@/lib/auth-session";

export default async function NewServerPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await getServerSession();
  if (!session) await redirect("/sign-in?redirect=/servers/new");

  const t = await getTranslations("newServer");

  return (
    <div className="max-w-xl py-8 px-4 mx-auto w-full">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ServerForm mode={{ type: "create" }} />
        </CardContent>
      </Card>
    </div>
  );
}
