import { redirect } from "next/navigation";
import { Aperture } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { hasAnyUser } from "@/actions/users";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SetupForm } from "./setup-form";

export default async function SetupPage() {
  if (await hasAnyUser()) {
    redirect("/sign-in");
  }

  const t = await getTranslations("setup");
  const tApp = await getTranslations("app");

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2 mb-2">
            <Aperture />
            <span className="font-bold">{tApp("name")}</span>
          </div>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <SetupForm />
        </CardContent>
      </Card>
    </div>
  );
}
