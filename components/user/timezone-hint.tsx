"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { setMyTimeZone } from "@/actions/profile";
import { Button } from "@/components/ui/button";

const DISMISS_KEY = "tz-hint-dismissed";

/** Shown once to a user with no saved zone whose browser disagrees with the app's. */
export function TimezoneHint({ appTimeZone }: { appTimeZone: string }) {
  const t = useTranslations("profile");
  const [browserZone, setBrowserZone] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
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
            const res = await setMyTimeZone(browserZone);
            if (res.success) dismiss();
            else toast.error(res.message);
          })
        }
      >
        {t("tzHintUse")}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label={t("tzHintDismiss")}
        onClick={dismiss}
      >
        <X />
      </Button>
    </div>
  );
}
