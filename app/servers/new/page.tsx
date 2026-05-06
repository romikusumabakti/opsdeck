import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ServerForm } from "@/components/server-form";
import { getServerSession } from "@/lib/auth-session";

export default async function NewServerPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in?redirect=/servers/new");

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
