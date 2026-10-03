"use client";

import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";

export function SectionError() {
  const t = useTranslations("homePage");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-6 text-sm text-muted-foreground">
      <span>{t("error.load")}</span>
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => startTransition(() => router.refresh())}
      >
        {t("error.retry")}
      </Button>
    </div>
  );
}
