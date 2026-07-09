"use client";

import { Database, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import {
  createDatabase,
  type DatabaseEntry,
  dropDatabase,
  renameDatabase,
} from "@/actions/databases";
import { useDialog } from "@/components/dialog-provider";
import { LiveRunDialog } from "@/components/live-run-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "@/i18n/navigation";
import type { SafeProjectWithServers } from "@/lib/db/schema";
import { formatBytes } from "@/lib/utils";

// Above this many databases the list gets a search box — small lists don't
// need one and the extra control just adds noise.
const SEARCH_THRESHOLD = 8;

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
  const [query, setQuery] = React.useState("");
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [taskTitle, setTaskTitle] = React.useState("");
  const [taskTarget, setTaskTarget] = React.useState("");
  const [submitting, startTransition] = React.useTransition();

  const showSearch = databases.length > SEARCH_THRESHOLD;
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return databases;
    return databases.filter((d) => d.name.toLowerCase().includes(q));
  }, [databases, query]);

  function onCreatePrompt() {
    void (async () => {
      const next = await dialog.prompt({
        title: t("createLabel"),
        description: t("createHint"),
        placeholder: t("createPlaceholder"),
        confirmText: t("create"),
        cancelText: tCommon("cancel"),
      });
      const name = next?.trim();
      if (!name) return;
      startTransition(async () => {
        try {
          const { runId } = await createDatabase(project.id, {
            database: name,
          });
          setTaskTitle(t("createTaskTitle"));
          setTaskTarget(name);
          setActiveTaskId(runId);
          toast.success(t("createQueuedTitle"), {
            description: t("createQueuedDescription", { dbName: name }),
          });
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : tCommon("errorGeneric")
          );
        }
      });
    })();
  }

  function onRename(name: string) {
    void (async () => {
      const next = await dialog.prompt({
        title: t("renameTitle"),
        description: t("renameDescription", { dbName: name }),
        confirmText: t("rename"),
        cancelText: tCommon("cancel"),
        defaultValue: name,
        placeholder: t("renamePlaceholder"),
      });
      const target = next?.trim();
      if (!target || target === name) return;
      startTransition(async () => {
        try {
          const { runId } = await renameDatabase(project.id, {
            from: name,
            to: target,
          });
          setTaskTitle(t("renameTaskTitle"));
          setTaskTarget(`${name} → ${target}`);
          setActiveTaskId(runId);
          toast.success(t("renameQueuedTitle"), {
            description: t("renameQueuedDescription", {
              from: name,
              to: target,
            }),
          });
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : tCommon("errorGeneric")
          );
        }
      });
    })();
  }

  function onDrop(name: string) {
    void (async () => {
      const ok = await dialog.confirmTyping({
        title: t("dropConfirmTitle"),
        description: t("dropConfirmDescription", { dbName: name }),
        phrase: name,
        phraseLabel: t("dropConfirmTypingLabel"),
        placeholder: t("dropConfirmTypingPlaceholder"),
        confirmText: t("drop"),
        cancelText: tCommon("cancel"),
      });
      if (!ok) return;
      startTransition(async () => {
        try {
          const { runId } = await dropDatabase(project.id, { database: name });
          setTaskTitle(t("dropTaskTitle"));
          setTaskTarget(name);
          setActiveTaskId(runId);
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
    <div className="flex flex-1 min-h-0 flex-col gap-2">
      {/* Create moved into a dialog (the button below) so the list, not an
          always-open form, owns the card's height. */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label>{t("existingLabel")}</Label>
          <span className="text-xs text-muted-foreground tabular-nums">
            {t("count", { count: databases.length })}
          </span>
        </div>
        <Button onClick={onCreatePrompt} disabled={submitting}>
          <Plus className="size-4" />
          {submitting ? t("queuing") : t("create")}
        </Button>
      </div>

      {showSearch && (
        <div className="shrink-0 relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="pl-8 font-mono text-sm"
              autoComplete="off"
              spellCheck={false}
              aria-label={t("searchPlaceholder")}
            />
          </div>
        )}

        {filtered.length === 0 ? (
          <EmptyState
            icon={Search}
            title={t("noMatchTitle")}
            description={t("noMatchDescription")}
            className="rounded-md border py-10"
          />
        ) : (
          // Fill the card's remaining height and scroll only these rows so the
          // header, search, tab bar, and page header stay pinned. The min-h
          // floor keeps the list usable (~6 rows) on short viewports — if the
          // card can't fit it, the page scrolls as a graceful fallback.
          <ul className="flex flex-1 min-h-[16rem] flex-col divide-y overflow-y-auto rounded-md border">
            {filtered.map((d) => (
              <li
                key={d.name}
                className="flex items-center gap-2 px-3 py-2 text-sm"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Database className="size-4 shrink-0 text-muted-foreground" />
                  <code className="min-w-0 truncate font-mono text-xs">
                    {d.name}
                  </code>
                  {d.isDefault && (
                    <Badge variant="secondary" className="shrink-0">
                      {t("defaultBadge")}
                    </Badge>
                  )}
                </div>
                {d.sizeBytes !== undefined && (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {formatBytes(d.sizeBytes)}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  disabled={d.isDefault || submitting}
                  onClick={() => onRename(d.name)}
                  title={
                    d.isDefault ? t("cannotRenameDefault") : t("renameTitle")
                  }
                  aria-label={t("renameTitle")}
                >
                  <Pencil className="size-4" />
                </Button>
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
        )}

      <LiveRunDialog
        runId={activeTaskId}
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
