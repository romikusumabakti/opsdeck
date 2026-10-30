import type { ErrorComponentProps } from "@tanstack/react-router";
import { useRouter } from "@tanstack/react-router";
import { AlertTriangle, FileQuestion, Home, RotateCcw } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

// The translated error and 404 screens (ports of app/[locale]/error.tsx and
// not-found.tsx). They need the locale's messages, so they render below the
// $locale route's IntlProvider: as the router's default boundaries for every
// page under it — inside the app shell, as Next rendered them inside the
// layout — and wrapped in their own provider by $locale's own boundaries.

export function LocaleErrorContent({ error, reset }: ErrorComponentProps) {
  const t = useTranslations("common");
  const router = useRouter();
  const message = error instanceof Error ? error.message : "";

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
        {message && (
          <div className="w-full rounded-md border bg-muted/40 px-3 py-2 text-start">
            <span className="text-xs font-medium text-muted-foreground">
              {t("errorDetails")}
            </span>
            <p className="mt-0.5 font-mono text-xs text-foreground/80 break-words">
              {message}
            </p>
          </div>
        )}
        <div className="flex flex-col-reverse sm:flex-row gap-2 mt-2">
          <Button
            render={<Link href="/" />}
            nativeButton={false}
            variant="outline"
          >
            <Home className="size-4" />
            {t("backToHome")}
          </Button>
          <Button
            onClick={() => {
              // reset() clears the boundary; invalidate() re-runs the
              // loaders that threw.
              reset();
              void router.invalidate();
            }}
          >
            <RotateCcw className="size-4" />
            {t("tryAgain")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function LocaleNotFoundContent() {
  const t = useTranslations("common");
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
        <Button
          render={<Link href="/" />}
          nativeButton={false}
          className="mt-2"
        >
          <Home className="size-4" />
          {t("backToHome")}
        </Button>
      </div>
    </div>
  );
}
