"use client";

import { formatDistanceToNow } from "date-fns";
import { Bell, CircleAlert, CircleDot } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "@/actions/notifications";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useRouter } from "@/i18n/navigation";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import type { Notification } from "@/lib/db/schema";
import { cn } from "@/lib/utils";

export function NotificationBell({
  initialNotifications,
  initialUnread,
}: {
  initialNotifications: Notification[];
  initialUnread: number;
}) {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const dfl = getDateFnsLocale(locale);
  const router = useRouter();

  const [items, setItems] = React.useState(initialNotifications);
  const [unread, setUnread] = React.useState(initialUnread);
  const [open, setOpen] = React.useState(false);

  // Re-sync when the server component re-renders (router.refresh after actions).
  React.useEffect(() => setItems(initialNotifications), [initialNotifications]);
  React.useEffect(() => setUnread(initialUnread), [initialUnread]);

  async function onItemClick(n: Notification) {
    setOpen(false);
    if (!n.readAt) {
      setItems((prev) =>
        prev.map((i) => (i.id === n.id ? { ...i, readAt: new Date() } : i))
      );
      setUnread((u) => Math.max(0, u - 1));
      await markNotificationRead(n.id);
    }
    if (n.href) router.push(n.href);
    router.refresh();
  }

  async function onMarkAll() {
    setItems((prev) =>
      prev.map((i) => ({ ...i, readAt: i.readAt ?? new Date() }))
    );
    setUnread(0);
    await markAllNotificationsRead();
    router.refresh();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="relative size-8"
            aria-label={t("ariaLabel")}
          />
        }
      >
        <Bell className="size-4" />
        {unread > 0 ? (
          <span className="absolute -top-0.5 -end-0.5 flex min-w-4 h-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2.5 border-b">
          <span className="text-sm font-medium">{t("title")}</span>
          {unread > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={onMarkAll}
            >
              {t("markAllRead")}
            </Button>
          ) : null}
        </div>
        {items.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            {t("empty")}
          </p>
        ) : (
          <ul className="max-h-96 overflow-y-auto divide-y">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onItemClick(n)}
                  className="flex w-full items-start gap-2.5 px-3 py-2.5 text-start hover:bg-accent/50 transition-colors"
                >
                  <span className="mt-0.5 shrink-0 text-muted-foreground">
                    {n.type === "run_failed" ? (
                      <CircleAlert className="size-4 text-destructive" />
                    ) : (
                      <CircleDot className="size-4" />
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm leading-snug">
                      {t(
                        n.type as "issue_assigned" | "run_failed",
                        n.data as Record<string, string | number>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(n.createdAt), {
                        addSuffix: true,
                        locale: dfl,
                      })}
                    </span>
                  </span>
                  {!n.readAt ? (
                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
