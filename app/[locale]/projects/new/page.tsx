import { Copy, FolderPlus } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { getProjectById } from "@/actions/projects";
import { getServers } from "@/actions/servers";
import { PageHeader } from "@/components/page-header";
import { ProjectForm } from "@/components/project-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth-session";

export default async function NewProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const [{ locale }, { from }] = await Promise.all([params, searchParams]);
  setRequestLocale(locale);

  await requireAdmin();

  const t = await getTranslations("newProject");
  const [servers, cloneFrom] = await Promise.all([
    getServers(),
    from ? getProjectById(from) : Promise.resolve(undefined),
  ]);

  const isCloning = Boolean(cloneFrom);

  return (
    <>
      <PageHeader
        title={isCloning ? t("cloneTitle") : t("title")}
        subtitle={
          isCloning && cloneFrom
            ? t("cloneDescription", { name: cloneFrom.name })
            : t("description")
        }
      />
      <Card className="max-w-2xl w-full">
        <CardHeader>
          <div className="flex items-center gap-2">
            {isCloning ? (
              <Copy className="size-5 text-muted-foreground" />
            ) : (
              <FolderPlus className="size-5 text-muted-foreground" />
            )}
            <CardTitle className="text-base">
              {isCloning ? t("cloneFormTitle") : t("formTitle")}
            </CardTitle>
          </div>
          <CardDescription>
            {isCloning ? t("cloneFormDescription") : t("formDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProjectForm
            mode={{ type: "create", cloneFrom: cloneFrom ?? undefined }}
            servers={servers}
          />
        </CardContent>
      </Card>
    </>
  );
}
