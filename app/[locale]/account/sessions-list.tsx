"use client";

import { Loader2, LogOut, Monitor } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { useDialog } from "@/components/dialog-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { authClient } from "@/lib/auth-client";

type Session = {
  id: string;
  token: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  expiresAt: Date | string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function shortenUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const browser = /(Chrome|Firefox|Safari|Edge|Opera)\/[\d.]+/.exec(ua);
  const os =
    /(Windows NT [\d.]+|Mac OS X [\d_.]+|Linux|Android [\d.]+|iOS [\d_.]+|iPhone|iPad)/.exec(
      ua
    );
  const browserName = browser?.[1] ?? "Browser";
  const osName = os?.[1]?.replace(/_/g, ".") ?? "Unknown OS";
  return `${browserName} · ${osName}`;
}

export function SessionsList({ currentToken }: { currentToken: string }) {
  const t = useTranslations("account.sessions");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const dialog = useDialog();
  const [sessions, setSessions] = React.useState<Session[] | null>(null);
  const [pendingToken, setPendingToken] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const { data, error } = await authClient.listSessions();
    if (error) {
      toast.error(error.message ?? tCommon("errorGeneric"));
      setSessions([]);
      return;
    }
    setSessions((data ?? []) as Session[]);
  }, [tCommon]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  async function onRevoke(session: Session) {
    const ok = await dialog.confirm({
      title: t("revokeTitle"),
      description: t("revokeDescription"),
      confirmText: t("revoke"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;
    setPendingToken(session.token);
    const { error } = await authClient.revokeSession({ token: session.token });
    setPendingToken(null);
    if (error) {
      toast.error(error.message ?? tCommon("errorGeneric"));
      return;
    }
    toast.success(t("revokedSuccess"));
    await refresh();
  }

  if (sessions === null) {
    return (
      <div className="py-10 flex items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={Monitor}
        title={t("emptyTitle")}
        description={t("emptyDescription")}
      />
    );
  }

  return (
    <ul className="divide-y">
      {sessions.map((s) => {
        const isCurrent = s.token === currentToken;
        return (
          <li
            key={s.id}
            className="flex items-center justify-between gap-4 py-3"
          >
            <div className="flex items-center gap-3 min-w-0">
              <span className="size-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                <Monitor className="size-4 text-muted-foreground" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">
                    {shortenUserAgent(s.userAgent)}
                  </span>
                  {isCurrent && (
                    <Badge variant="secondary" className="text-xs">
                      {t("current")}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {s.ipAddress ?? t("unknownIp")} ·{" "}
                  {t("signedInAt", {
                    date: format.dateTime(new Date(s.createdAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })}
                </div>
              </div>
            </div>
            {!isCurrent && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRevoke(s)}
                disabled={pendingToken === s.token}
                className="shrink-0"
              >
                <LogOut className="size-4" />
                {t("revoke")}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
