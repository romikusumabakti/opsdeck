"use client";

import { Database, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import {
  createDatabase,
  type DatabaseEntry,
  dropDatabase,
} from "@/actions/databases";
import { useDialog } from "@/components/dialog-provider";
import { LiveTaskDialog } from "@/components/live-task-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "@/i18n/navigation";
import type { SafeProjectWithServers } from "@/lib/db/schema";

export function ManageDatabases({
  project,
  databases,
}: {
  project: SafeProjectWithServers;
  databases: DatabaseEntry[];
}) {
  const t = useTranslations("databases");
  const tCommon = useTranslations("common");
  const dialog = useDialog();
  const router = useRouter();
  const [newName, setNewName] = React.useState("");
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [taskTitle, setTaskTitle] = React.useState("");
  const [taskTarget, setTaskTarget] = React.useState("");
  const [submitting, startTransition] = React.useTransition();

  const trimmed = newName.trim();

  function onCreate() {
    if (!trimmed) return;
    startTransition(async () => {
      try {
        const { taskId } = await createDatabase(project.id, {
          database: trimmed,
        });
        setTaskTitle(t("createTaskTitle"));
        setTaskTarget(trimmed);
        setActiveTaskId(taskId);
        setNewName("");
        toast.success(t("createQueuedTitle"), {
          description: t("createQueuedDescription", { dbName: trimmed }),
        });
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : tCommon("errorGeneric")
        );
      }
    });
  }

  function onDrop(name: string) {
    void (async () => {
      const ok = await dialog.confirm({
        title: t("dropConfirmTitle"),
        description: t("dropConfirmDescription", { dbName: name }),
        confirmText: t("drop"),
        cancelText: tCommon("cancel"),
        destructive: true,
      });
      if (!ok) return;
      startTransition(async () => {
        try {
          const { taskId } = await dropDatabase(project.id, { database: name });
          setTaskTitle(t("dropTaskTitle"));
          setTaskTarget(name);
          setActiveTaskId(taskId);
          toast.success(t("dropQueuedTitle"), {
            description: t("dropQueuedDescription", { dbName: name }),
          });
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : tCommon("errorGeneric")
          );
        }
      });
    })();
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate();
        }}
      >
        <Label htmlFor="new-database-name">{t("createLabel")}</Label>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            id="new-database-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("createPlaceholder")}
            disabled={submitting}
            className="flex-1 font-mono text-sm"
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" disabled={!trimmed || submitting}>
            <Plus className="size-4" />
            {submitting ? t("queuing") : t("create")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("createHint")}</p>
      </form>

      <div className="flex flex-col gap-2">
        <Label>{t("existingLabel")}</Label>
        <ul className="flex flex-col divide-y rounded-md border">
          {databases.map((d) => (
            <li
              key={d.name}
              className="flex items-center gap-2 px-3 py-2 text-sm"
            >
              <Database className="size-4 shrink-0 text-muted-foreground" />
              <code className="font-mono text-xs truncate flex-1 min-w-0">
                {d.name}
              </code>
              {d.isDefault && (
                <Badge variant="secondary" className="shrink-0">
                  {t("defaultBadge")}
                </Badge>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0 text-destructive hover:text-destructive"
                disabled={d.isDefault || submitting}
                onClick={() => onDrop(d.name)}
                title={d.isDefault ? t("cannotDropDefault") : t("dropTitle")}
                aria-label={t("dropTitle")}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      </div>

      <LiveTaskDialog
        taskId={activeTaskId}
        onOpenChange={(open) => {
          if (!open) {
            setActiveTaskId(null);
            // Refresh so the database list reflects the create/drop result.
            router.refresh();
          }
        }}
        title={taskTitle}
        description={<code className="font-mono text-xs">{taskTarget}</code>}
      />
    </div>
  );
}
