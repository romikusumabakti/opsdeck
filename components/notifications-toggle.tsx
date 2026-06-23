"use client";

import { Bell, BellOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useNotificationsState } from "@/hooks/use-task-notifications";

export function NotificationsToggle() {
  const t = useTranslations("notifications");
  const state = useNotificationsState();

  if (!state.supported) {
    return (
      <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <div className="font-medium text-foreground">
          {t("unsupportedTitle")}
        </div>
        <div className="text-xs mt-0.5">{t("unsupportedDescription")}</div>
      </div>
    );
  }

  const blocked = state.permission === "denied";
  const enabled = state.enabled && state.permission === "granted";

  async function onToggle() {
    if (enabled) {
      state.setEnabled(false);
      return;
    }
    if (state.permission !== "granted") {
      const result = await state.requestPermission();
      if (result !== "granted") {
        toast.error(t("permissionDeniedTitle"), {
          description: t("permissionDeniedDescription"),
        });
        return;
      }
    }
    state.setEnabled(true);
    toast.success(t("enabled"));
  }

  return (
    <div className="flex flex-col gap-2">
      {blocked && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
          <div className="font-medium text-destructive">
            {t("blockedTitle")}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {t("blockedDescription")}
          </div>
        </div>
      )}
      {/* When blocked, the OS/browser owns the decision — a disabled "Enable"
          button is dead UI. Hide it; the banner already tells the user what to
          do. Only show the toggle when an action is actually possible. */}
      {!blocked && (
        <Button
          type="button"
          variant={enabled ? "outline" : "default"}
          onClick={onToggle}
          className="self-start"
        >
          {enabled ? (
            <BellOff className="size-4" />
          ) : (
            <Bell className="size-4" />
          )}
          {enabled ? t("disable") : t("enable")}
        </Button>
      )}
    </div>
  );
}
