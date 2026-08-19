"use client";

import { format, formatDistanceToNow } from "date-fns";
import { Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";
import { folderStats } from "@/actions/explorer";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getDateFnsLocale } from "@/lib/date-fns-locale";
import type { ExplorerEntry, ExplorerSource } from "@/lib/explorer";
import { formatBytes } from "@/lib/utils";

type Props = {
  source: ExplorerSource;
  entry: ExplorerEntry;
  onClose: () => void;
};

type Stats = { files: number; folders: number; bytes: number };

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-start gap-3 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-sm">{children}</span>
    </div>
  );
}

// What the listing already knows about an entry, plus — on request — what a
// folder holds. The recursive walk is behind a button on purpose: it is a full
// tree traversal over SFTP or a bucket, far too costly to run on open.
export default function EntryPropertiesDialog({
  source,
  entry,
  onClose,
}: Props) {
  const t = useTranslations("explorer");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  const [stats, setStats] = React.useState<Stats | null>(null);
  const [counting, setCounting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function calculate() {
    setCounting(true);
    setError(null);
    const result = await folderStats(source, entry.path);
    setCounting(false);
    if (result.success) setStats(result.data);
    else setError(result.message);
  }

  const modified = entry.modifiedAt ? new Date(entry.modifiedAt) : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate">{entry.name}</DialogTitle>
        </DialogHeader>

        <div className="divide-y">
          <Row label={t("kind")}>
            {entry.type === "dir" ? t("kindFolder") : t("kindFile")}
          </Row>
          <Row label={t("location")}>
            <span className="font-mono text-xs">
              /{entry.path.replace(/\/+$/, "")}
            </span>
          </Row>
          <Row label={t("size")}>
            {entry.type === "file" ? (
              entry.sizeBytes != null ? (
                `${formatBytes(entry.sizeBytes)} (${entry.sizeBytes.toLocaleString(locale)} B)`
              ) : (
                "—"
              )
            ) : stats ? (
              `${formatBytes(stats.bytes)} (${stats.bytes.toLocaleString(locale)} B)`
            ) : (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={calculate}
                disabled={counting}
              >
                {counting ? <Loader2 className="animate-spin" /> : null}
                {t("calculateSize")}
              </Button>
            )}
          </Row>
          {entry.type === "dir" && stats ? (
            <Row label={t("contents")}>
              {t("contentsCount", {
                files: stats.files,
                folders: stats.folders,
              })}
            </Row>
          ) : null}
          <Row label={t("modified")}>
            {modified
              ? `${format(modified, "PPpp", {
                  locale: getDateFnsLocale(locale),
                })} · ${formatDistanceToNow(modified, {
                  addSuffix: true,
                  locale: getDateFnsLocale(locale),
                })}`
              : "—"}
          </Row>
          {error ? (
            <Row label={t("loadFailed")}>
              <span className="text-destructive">{error}</span>
            </Row>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
