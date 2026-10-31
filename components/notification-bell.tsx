import { AtSign, Bell, CircleAlert, CircleDot } from "lucide-react";
import * as React from "react";
import { useTranslations } from "use-intl";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TooltipHint } from "@/components/ui/tooltip";
import { useRouter } from "@/i18n/navigation";
import type { Notification } from "@/web/api/notifications";
import {
  markAllNotificationsRead,
  markNotificationRead,
} from "@/web/api/notifications";

export function NotificationBell({
  initialNotifications,
  initialUnread,
}: {
  initialNotifications: Notification[];
  initialUnread: number;
}) {
  const t = useTranslations("notifications");
  const router = useRouter();

  const [items, setItems] = React.useState(initialNotifications);
  const [unread, setUnread] = React.useState(initialUnread);
  const [open, setOpen] = React.useState(false);

  // Re-sync when the queries refetch (after a mutation, or on focus).
  React.useEffect(() => setItems(initialNotifications), [initialNotifications]);
  React.useEffect(() => setUnread(initialUnread), [initialUnread]);

  async function onItemClick(n: Notification) {
    setOpen(false);
    if (!n.readAt) {
      setItems((prev) =>
        prev.map((i) =>
          i.id === n.id ? { ...i, readAt: new Date().toISOString() } : i
        )
      );
      setUnread((u) => Math.max(0, u - 1));
      await markNotificationRead(n.id);
    }
    if (n.href) router.push(n.href);
  }

  async function onMarkAll() {
    setItems((prev) =>
      prev.map((i) => ({ ...i, readAt: i.readAt ?? new Date().toISOString() }))
    );
    setUnread(0);
    await markAllNotificationsRead();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <TooltipHint label={t("ariaLabel")}>
            <Button
              variant="ghost"
              size="icon"
              className="relative size-8"
              aria-label={t("ariaLabel")}
            />
          </TooltipHint>
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
                    ) : n.type === "issue_mention" ? (
                      <AtSign className="size-4" />
                    ) : (
                      <CircleDot className="size-4" />
                    )}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm leading-snug">
                      {t(
                        n.type as
                          | "issue_assigned"
                          | "run_failed"
                          | "issue_mention",
                        n.data as Record<string, string | number>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      <RelativeTime date={n.createdAt} />
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
