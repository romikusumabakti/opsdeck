import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getServerById } from "@/actions/servers";
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

export default async function EditServerPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  const session = await getServerSession();
  if (!session) await redirect("/sign-in?redirect=/servers");

  const server = await getServerById(id);
  if (!server) notFound();

  const t = await getTranslations("editServer");

  return (
    <div className="max-w-xl py-8 px-4 mx-auto w-full">
      <Card>
        <CardHeader>
          <CardTitle>{t("title", { name: server.name })}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ServerForm mode={{ type: "edit", server }} />
        </CardContent>
      </Card>
    </div>
  );
}
