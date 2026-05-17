import { FileQuestion, Home } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

export default async function LocaleNotFound() {
  const t = await getTranslations("common");

  return (
    <div className="flex flex-1 items-center justify-center py-12">
      <div className="flex flex-col items-center gap-4 text-center max-w-md">
        <div className="size-12 rounded-full bg-muted text-muted-foreground flex items-center justify-center">
          <FileQuestion className="size-6" />
        </div>
        <h1 className="text-xl font-semibold">{t("notFoundTitle")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("notFoundDescription")}
        </p>
        <Button asChild className="mt-2">
          <Link href="/">
            <Home className="size-4" />
            {t("backToHome")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
