"use client";

import { Pencil, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { deleteServer } from "@/actions/servers";
import { useDialog } from "@/components/dialog-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import type { Server } from "@/lib/db/schema";

export function ServersClient({ servers }: { servers: Server[] }) {
  const t = useTranslations("servers");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const [isPending, startTransition] = useTransition();

  async function onDelete(server: Server) {
    const ok = await dialog.confirm({
      title: t("deleteTitle"),
      description: t("deleteDescription", {
        name: server.name,
        host: server.host,
      }),
      confirmText: tCommon("delete"),
      cancelText: tCommon("cancel"),
    });
    if (!ok) return;
    startTransition(async () => {
      const result = await deleteServer(server.id);
      if (!result.success) {
        await dialog.alert({
          title: t("deleteFailed"),
          description: result.message,
        });
      }
    });
  }

  if (servers.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground">
          {t("empty")}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <ul className="divide-y">
          {servers.map((server) => (
            <li
              key={server.id}
              className="flex items-center justify-between gap-4 px-6 py-3"
            >
              <div className="min-w-0">
                <div className="font-medium truncate">{server.name}</div>
                <div className="text-sm text-muted-foreground truncate">
                  {server.username}@{server.host}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button asChild variant="ghost" size="icon">
                  <Link
                    href={`/servers/${server.id}`}
                    aria-label={t("editAriaLabel")}
                  >
                    <Pencil className="size-4" />
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onDelete(server)}
                  disabled={isPending}
                  aria-label={t("deleteAriaLabel")}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
