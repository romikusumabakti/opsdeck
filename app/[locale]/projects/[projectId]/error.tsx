"use client";

import { AlertTriangle, ArrowLeft, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("common");

  React.useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="rounded-lg border bg-card p-6 flex items-start gap-4">
      <div className="size-10 rounded-full bg-destructive/10 text-destructive flex items-center justify-center shrink-0">
        <AlertTriangle className="size-5" />
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        <div>
          <h2 className="text-base font-semibold">{t("errorTitle")}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t("errorDescription")}
          </p>
          {error.digest && (
            <code className="font-mono text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded mt-2 inline-block">
              {error.digest}
            </code>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={reset}>
            <RotateCcw className="size-4" />
            {t("tryAgain")}
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/">
              <ArrowLeft className="size-4" />
              {t("backToHome")}
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
