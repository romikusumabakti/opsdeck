import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";

export function SectionError() {
  const t = useTranslations("homePage");
  const router = useRouter();
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-6 text-sm text-muted-foreground">
      <span>{t("error.load")}</span>
      <Button variant="outline" size="sm" onClick={() => router.refresh()}>
        {t("error.retry")}
      </Button>
    </div>
  );
}
