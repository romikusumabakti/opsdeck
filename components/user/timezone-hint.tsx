import { X } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { useTranslations } from "use-intl";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { browserTimeZone } from "@/lib/format-date";
import { setMyTimeZone } from "@/web/api/profile";

const DISMISS_KEY = "tz-hint-dismissed";

/** Shown once to a user with no saved zone whose browser disagrees with the app's. */
export function TimezoneHint({ appTimeZone }: { appTimeZone: string }) {
  const t = useTranslations("profile");
  const tCommon = useTranslations("common");
  const [browserZone, setBrowserZone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const zone = browserTimeZone();
    if (zone && zone !== appTimeZone && !localStorage.getItem(DISMISS_KEY)) {
      setBrowserZone(zone);
    }
  }, [appTimeZone]);

  if (!browserZone) return null;
  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setBrowserZone(null);
  };
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm"
    >
      <span className="flex-1">{t("tzHint", { zone: browserZone })}</span>
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            try {
              const res = await setMyTimeZone(browserZone);
              if (res.success) dismiss();
              else toast.error(res.message);
            } catch {
              toast.error(tCommon("errorGeneric"));
            }
          })
        }
      >
        {t("tzHintUse")}
      </Button>
      <TooltipHint label={t("tzHintDismiss")}>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("tzHintDismiss")}
          onClick={dismiss}
        >
          <X />
        </Button>
      </TooltipHint>
    </div>
  );
}
