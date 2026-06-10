"use client";

import { AlertTriangle, Home, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

export default function LocaleError({
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
    <div className="flex flex-1 items-center justify-center py-12">
      <div className="flex flex-col items-center gap-4 text-center max-w-md">
        <div className="size-12 rounded-full bg-destructive/10 text-destructive flex items-center justify-center">
          <AlertTriangle className="size-6" />
        </div>
        <h1 className="text-xl font-semibold">{t("errorTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("errorDescription")}</p>
        {error.message && (
          <div className="w-full rounded-md border bg-muted/40 px-3 py-2 text-start">
            <span className="text-xs font-medium text-muted-foreground">
              {t("errorDetails")}
            </span>
            <p className="mt-0.5 font-mono text-xs text-foreground/80 break-words">
              {error.message}
            </p>
          </div>
        )}
        {error.digest && (
          <code className="font-mono text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded">
            {error.digest}
          </code>
        )}
        <div className="flex flex-col-reverse sm:flex-row gap-2 mt-2">
          <Button asChild variant="outline">
            <Link href="/">
              <Home className="size-4" />
              {t("backToHome")}
            </Link>
          </Button>
          <Button onClick={reset}>
            <RotateCcw className="size-4" />
            {t("tryAgain")}
          </Button>
        </div>
      </div>
    </div>
  );
}
