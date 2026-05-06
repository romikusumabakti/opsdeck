import { getTranslations } from "next-intl/server";
import { getServers } from "@/actions/servers";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { NewProjectForm } from "./new-project-form";

export default async function NewProjectPage() {
  const t = await getTranslations("newProject");
  const servers = await getServers();

  return (
    <div className="max-w-3xl py-8 px-4 mx-auto w-full">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <NewProjectForm servers={servers} />
        </CardContent>
      </Card>
    </div>
  );
}
