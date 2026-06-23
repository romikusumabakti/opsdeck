import { Folder, ServerCog } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getServerById, getServerUsage } from "@/actions/servers";
import { PageHeader } from "@/components/page-header";
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
import { Link } from "@/i18n/navigation";
import { requireAdmin } from "@/lib/auth-session";

export default async function EditServerPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  await requireAdmin();

  const [server, usage] = await Promise.all([
    getServerById(id),
    getServerUsage(id),
  ]);
  if (!server) notFound();

  const t = await getTranslations("editServer");
  const tForm = await getTranslations("serverForm");
  const tDash = await getTranslations("dashboard");

  return (
    <>
      <PageHeader
        title={t("title", { name: server.name })}
        subtitle={t("description")}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem] max-w-5xl w-full">
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
                      title={u.project.name}
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
    </>
  );
}
