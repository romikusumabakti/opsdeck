import { ServerCog } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ServerForm } from "@/components/server-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth-session";

export default async function NewServerPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requireAdmin();

  const t = await getTranslations("newServer");

  return (
    <div className="max-w-2xl py-8 px-4 mx-auto w-full">
      <div className="mb-6 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ServerCog className="size-5 text-muted-foreground" />
            <CardTitle className="text-base">{t("formTitle")}</CardTitle>
          </div>
          <CardDescription>{t("formDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ServerForm mode={{ type: "create" }} />
        </CardContent>
      </Card>
    </div>
  );
}
