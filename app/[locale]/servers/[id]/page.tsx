import { Folder, ServerCog } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getServerById, getServerUsage } from "@/actions/servers";
import { ServerForm } from "@/components/server-form";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Link, redirect } from "@/i18n/navigation";
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

  const [server, usage] = await Promise.all([
    getServerById(id),
    getServerUsage(id),
  ]);
  if (!server) notFound();

  const t = await getTranslations("editServer");
  const tForm = await getTranslations("serverForm");
  const tDash = await getTranslations("dashboard");

  return (
    <div className="max-w-4xl py-8 px-4 mx-auto w-full">
      <div className="mb-6 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("title", { name: server.name })}
        </h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <ServerCog className="size-5 text-muted-foreground" />
              <CardTitle className="text-base">{t("formTitle")}</CardTitle>
            </div>
            <CardDescription>{t("formDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ServerForm mode={{ type: "edit", server }} />
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">
              {tForm("usageTitle")}{" "}
              <span className="text-muted-foreground font-normal">
                ({usage.length})
              </span>
            </CardTitle>
            <CardDescription>{tForm("usageDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {usage.length === 0 ? (
              <EmptyState
                icon={Folder}
                title={tForm("usageEmptyTitle")}
                description={tForm("usageEmptyDescription")}
                className="py-10"
              />
            ) : (
              <ul className="divide-y border-t">
                {usage.map((u) => (
                  <li
                    key={u.project.id}
                    className="flex items-center justify-between gap-2 px-6 py-3"
                  >
                    <Link
                      href={`/projects/${u.project.id}`}
                      className="font-medium truncate hover:underline"
                    >
                      {u.project.name}
                    </Link>
                    <span className="flex flex-wrap gap-1 shrink-0">
                      {u.roles.map((r) => (
                        <Badge key={r} variant="secondary" className="text-xs">
                          {tDash(r === "db" ? "database" : r)}
                        </Badge>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
