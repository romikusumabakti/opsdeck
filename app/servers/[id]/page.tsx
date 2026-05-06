import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getServerById } from "@/actions/servers";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ServerForm } from "@/components/server-form";
import { getServerSession } from "@/lib/auth-session";

export default async function EditServerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/sign-in?redirect=/servers");

  const { id } = await params;
  const serverId = parseInt(id);
  if (Number.isNaN(serverId)) notFound();

  const server = await getServerById(serverId);
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
