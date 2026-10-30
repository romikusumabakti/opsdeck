import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, RotateCcw } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

// The environment area's error boundary: a card inside the page, so the
// header and sidebar stay (the port of `[envSlug]/error.tsx`).
export function EnvError({ error, reset }: ErrorComponentProps) {
  const t = useTranslations("common");
  const router = useRouter();

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
          {(error as Error).message && (
            <div className="mt-2 rounded-md border bg-muted/40 px-3 py-2">
              <span className="text-xs font-medium text-muted-foreground">
                {t("errorDetails")}
              </span>
              <p className="mt-0.5 font-mono text-xs text-foreground/80 break-words">
                {(error as Error).message}
              </p>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
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
          <Button
            render={<Link href="/" />}
            nativeButton={false}
            size="sm"
            variant="outline"
          >
            <ArrowLeft className="size-4" />
            {t("backToHome")}
          </Button>
        </div>
      </div>
    </div>
  );
}
